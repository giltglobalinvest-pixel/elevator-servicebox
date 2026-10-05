// Background sync ERP -> Airtable "Auftraege".
// Ported 1:1 from the Val.town proxy; only env access and blob storage are injected.

export const DEFAULT_AUFZUG_BASE_URL = "https://verwaltung.api.aufzugshandwerk.de/v1";

export function createSync({ env, blob }) {
  const ACTIVE_STATUSES = ["Auftrag bestätigt", "In Bearbeitung", "Abgeschlossen"];

  function normStatus(s) {
    const t = String(s||"").toLowerCase().trim();
    if (!t) return "offen";
    if (/abgerechnet/.test(t)) return "abgerechnet";
    if (/abgeschlossen/.test(t)) return "abgeschlossen";
    // Merged: 'In Bearbeitung' + 'Auftrag bestätigt' + legacy → 'offen'
    if (/bearbeit|best.tigt|^offen$|^in_bearbeitung$/.test(t)) return "offen";
    return t;
  }

  function buildKontakt(k) {
    const name  = [k.vorname, k.nachname].filter(Boolean).join(" ").trim();
    const phone = k.telefon || k.mobile || "";
    const parts = [];
    if (name) parts.push(name);
    if (phone) parts.push("Tel: "+phone);
    if (k.rolle) parts.push("Rolle: "+k.rolle);
    return parts.join("\n");
  }

  async function atReadAll(table, params) {
    const baseId  = env("AIRTABLE_BASE_ID");
    const readKey = env("AIRTABLE_READ_KEY");
    if (!baseId || !readKey) throw new Error("AIRTABLE_BASE_ID/AIRTABLE_READ_KEY env-var fehlt");
    let records = [];
    let offset = null;
    let safety = 0;
    do {
      let url = "https://api.airtable.com/v0/"+baseId+"/"+encodeURIComponent(table)+"?pageSize=100";
      if (params) url += "&"+params;
      if (offset) url += "&offset="+encodeURIComponent(offset);
      const r = await fetch(url, { headers: { Authorization: "Bearer "+readKey } });
      if (!r.ok) throw new Error("Airtable "+table+" GET "+r.status);
      const d = await r.json();
      records = records.concat(d.records || []);
      offset = d.offset || null;
      if (++safety > 50) break;
    } while (offset);
    return records;
  }

  async function atPatch(table, recId, fields) {
    const baseId   = env("AIRTABLE_BASE_ID");
    const writeKey = env("AIRTABLE_WRITE_KEY");
    if (!baseId || !writeKey) throw new Error("AIRTABLE_WRITE_KEY env-var fehlt (Setup neu durchlaufen)");
    const url = "https://api.airtable.com/v0/"+baseId+"/"+encodeURIComponent(table)+"/"+recId;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: "Bearer "+writeKey, "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    });
    const d = await r.json();
    if (!r.ok) throw new Error("Airtable PATCH "+r.status+": "+(d && d.error && d.error.message || ""));
    return d;
  }

  async function atCreate(table, fields) {
    const baseId   = env("AIRTABLE_BASE_ID");
    const writeKey = env("AIRTABLE_WRITE_KEY");
    if (!baseId || !writeKey) throw new Error("AIRTABLE_WRITE_KEY env-var fehlt (Setup neu durchlaufen)");
    const url = "https://api.airtable.com/v0/"+baseId+"/"+encodeURIComponent(table);
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer "+writeKey, "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    });
    const d = await r.json();
    if (!r.ok) throw new Error("Airtable POST "+r.status+": "+(d && d.error && d.error.message || ""));
    return d;
  }

  async function lookupTenant(firma) {
    try {
      const recs = await atReadAll("Firmen", "filterByFormula="+encodeURIComponent("{slug}='"+firma+"'")+"&maxRecords=1");
      const t = recs[0] && recs[0].fields && recs[0].fields.erp_tenant;
      if (t) return String(t).trim();
    } catch(_){}
    const LEGACY = { aufzug: "1", aszendio: "4" };
    return LEGACY[firma] || null;
  }

  async function erpGet(firma, tenant, apiKey, p) {
    const baseUrl = env("AUFZUG_BASE_URL") || DEFAULT_AUFZUG_BASE_URL;
    const url = baseUrl+"/"+p;
    const r = await fetch(url, { headers: { APIKEY: apiKey, TENANT: tenant, Accept: "application/json" } });
    if (!r.ok) {
      const txt = await r.text().catch(()=>"");
      throw new Error("ERP "+p+" HTTP "+r.status+(txt?" – "+txt.slice(0,150):""));
    }
    return r.json();
  }

  async function runSyncForFirma(firma, userKey) {
    const t0 = Date.now();
    try { await blob.setJSON("sync_status_"+firma, { firma, running: true, started: new Date(t0).toISOString(), triggered_by: userKey }); } catch(_){}

    const tenant = await lookupTenant(firma);
    if (!tenant) throw new Error("Kein ERP-Tenant fuer Firma '"+firma+"' (Firmen-Verwaltung).");
    const apiKey = env("AUFZUG_API_KEY_"+firma.toUpperCase()) || env("AUFZUG_API_KEY");
    if (!apiKey) throw new Error("Kein API-Key fuer Firma '"+firma+"'.");

    const existing = await atReadAll("Auftraege");
    const byExt = new Map();
    for (const r of existing) {
      if (r.fields && r.fields.ext_id && (r.fields.firma||"") === firma) {
        byExt.set(String(r.fields.ext_id), r);
      }
    }

    let all;
    try { all = await erpGet(firma, tenant, apiKey, "api/auftraege"); }
    catch(_) { all = await erpGet(firma, tenant, apiKey, "auftraege"); }
    if (!Array.isArray(all)) all = (all && (all.content || all.items || all.data)) || [];
    const active = all.filter(a => ACTIVE_STATUSES.indexOf(a.status) >= 0);

    const toProcess = [];
    let skipped = 0;
    for (const a of active) {
      const ex = byExt.get(String(a.id));
      if (ex && a.lastmodifiedDate && ex.fields.ext_last_modified === a.lastmodifiedDate) {
        skipped++;
        continue;
      }
      toProcess.push(a);
    }

    const angebotCache = new Map();
    const needsAngebot = [];
    for (const a of toProcess) {
      if (a.bestellform === "MITANGEBOT" && a.angebotid) {
        const ex = byExt.get(String(a.id));
        if (ex && String(ex.fields.angebot_id||"") === String(a.angebotid) && ex.fields.leistungsumfang) {
          angebotCache.set(String(a.angebotid), {
            serviceDescription: ex.fields.leistungsumfang,
            offerExplanation:   ex.fields.erlaeuterungen,
            typ:                ex.fields.angebot_typ
          });
        } else {
          needsAngebot.push(a);
        }
      }
    }
    if (needsAngebot.length > 0) {
      let idx = 0;
      const worker = async () => {
        while (idx < needsAngebot.length) {
          const a = needsAngebot[idx++];
          try {
            const ang = await erpGet(firma, tenant, apiKey, "api/angebote/"+a.angebotid);
            angebotCache.set(String(a.angebotid), ang);
          } catch(_) {}
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, needsAngebot.length) }, () => worker()));
    }

    let created = 0, updated = 0, unchanged = 0, withAngebot = 0, errors = 0;
    const USER_MANAGED = ["techniker_keys","techniker_namen","priority","tmpl","notizen","bilder","subunternehmer_preis","bericht_id","bericht_num","completed_at","created","created_by"];

    for (const a of toProcess) {
      try {
        let ang = null;
        if (a.bestellform === "MITANGEBOT" && a.angebotid) {
          ang = angebotCache.get(String(a.angebotid)) || null;
          if (ang) withAngebot++;
        }
        const anlage = a.anlage || {};
        const ansp = anlage.ansprechpartner || {};
        const empf = a.empfaenger || {};
        const hasAnsp = !!(ansp.vorname || ansp.nachname || ansp.telefon || ansp.mobile);
        const kontaktText = hasAnsp ? buildKontakt(ansp) : buildKontakt(empf);
        const haystack = [a.bestellform, a.leistungsbeschreibung, a.notizen, ang && ang.typ, ang && ang.serviceDescription, ang && ang.title, anlage.objektTyp].filter(Boolean).join(" ").toLowerCase();
        const isWartung = /wartung/.test(haystack);
        const tmplKey = firma + (isWartung ? "-wartung" : "-arbeit");
        const leistungsumfang = ((ang && ang.serviceDescription) || a.leistungsbeschreibung || a.notizen || "").toString().trim();

        const fields = {
          firma,
          auftrag_num: a.vorgangsnummer || a.id,
          ext_id: a.id,
          ext_source: "aufzugshandwerk_v1",
          ext_vorgangsnummer: a.vorgangsnummer || null,
          ext_last_modified: a.lastmodifiedDate || "",
          standort: anlage.anzeigeAdresse || anlage.name || "",
          fabriknummer: anlage.fabriknummer || "",
          kontakt: kontaktText,
          leistungsbeschreibung: a.leistungsbeschreibung || a.notizen || "",
          status: normStatus(a.status),
          priority: "normal",
          due_date: (a.ausfuehrungstermin || "").slice(0, 10) || "",
          created: a.createdDate || new Date().toISOString(),
          created_by: userKey,
          tmpl: tmplKey,
          stundensatz: anlage.stundensatz || null,
          einsatzpauschale: anlage.einsatzPauschale || null,
          objekttyp: anlage.objektTyp || "",
          kunde_firmenname: (anlage.kunde && anlage.kunde.firmenname) || "",
          leistungsumfang: leistungsumfang,
          erlaeuterungen: (ang && ang.offerExplanation) || "",
          angebot_typ: (ang && ang.typ) || "",
          angebot_id: a.angebotid || null,
          bestellform: a.bestellform || ""
        };

        const ex = byExt.get(String(a.id));
        if (ex) {
          const patch = Object.assign({}, fields);
          for (const k of USER_MANAGED) {
            const v = ex.fields[k];
            const hasVal = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
            if (hasVal) delete patch[k];
          }
          if (ex.fields.status === "abgerechnet") delete patch.status;
          const protectIfEmpty = ["kontakt","leistungsumfang","erlaeuterungen","standort","fabriknummer","due_date"];
          for (const k of protectIfEmpty) {
            if ((patch[k] === "" || patch[k] == null) && ex.fields[k]) delete patch[k];
          }
          const changed = {};
          for (const k of Object.keys(patch)) {
            const cur = ex.fields[k];
            const curN = (cur === null || cur === undefined) ? "" : cur;
            const newN = (patch[k] === null || patch[k] === undefined) ? "" : patch[k];
            if (String(curN) !== String(newN)) changed[k] = patch[k];
          }
          if (a.lastmodifiedDate && ex.fields.ext_last_modified !== a.lastmodifiedDate) {
            changed.ext_last_modified = a.lastmodifiedDate;
          }
          if (Object.keys(changed).length === 0) { unchanged++; continue; }
          await atPatch("Auftraege", ex.id, changed);
          updated++;
        } else {
          await atCreate("Auftraege", fields);
          created++;
        }
      } catch(e) { errors++; }
    }

    const result = {
      firma, running: false,
      started: new Date(t0).toISOString(),
      finished: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      total: active.length,
      toProcess: toProcess.length,
      skipped, created, updated, unchanged, withAngebot, errors,
      triggered_by: userKey
    };
    try { await blob.setJSON("sync_status_"+firma, result); } catch(_){}
    return result;
  }

  return { atReadAll, runSyncForFirma };
}
