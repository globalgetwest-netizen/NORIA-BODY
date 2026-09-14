/**
 * NORIA KNOWLEDGE BASE (Body-side, free, zero engine risk).
 *
 * Curated, vetted reference notes. For each question, retrieveKnowledge() finds
 * the most relevant notes and the app injects them into the prompt as
 * "[background knowledge]" — so Noria answers GROUNDED in these notes instead of
 * guessing. The Noria Engine is never modified; this is pure client context.
 *
 * ── HOW TO ADD YOUR OWN KNOWLEDGE ─────────────────────────────────────────────
 * Append entries to KNOWLEDGE below. Each entry:
 *   { id, topics: [keywords that should match a question], text: 'the fact' }
 * Keep `text` accurate, concise, and safety-aware. Prefer well-established facts;
 * cite the source in the text when you have one. Mechanisms + safety are more
 * useful (and safer) than prescriptive doses. Anything you add here immediately
 * grounds Noria's answers — so only add content you trust.
 */

export const KNOWLEDGE = [
  // ── General medicine & safety ──────────────────────────────────────────────
  {
    id: 'antibiotics-resistance',
    topics: ['antibiotic', 'antibiotics', 'antibacterial', 'bacteria', 'resistance', 'infection'],
    text: 'Antibiotics treat bacterial infections only — not viruses (colds, flu, most sore throats). Misuse and incomplete courses drive antibiotic resistance, a major global threat. Take exactly as prescribed, finish the course if told to, and never share or reuse antibiotics. Classes act differently: penicillins/cephalosporins block cell-wall building; macrolides/tetracyclines block protein synthesis; fluoroquinolones block DNA replication.',
  },
  {
    id: 'antivirals-general',
    topics: ['antiviral', 'antivirals', 'virus', 'viral', 'influenza', 'flu', 'herpes', 'covid'],
    text: 'Antivirals interrupt steps of viral replication (entry, genome copying, or assembly) rather than "killing" viruses the way antibiotics kill bacteria. Examples: oseltamivir inhibits influenza neuraminidase; acyclovir blocks herpes DNA polymerase; many are most effective started early in infection. Vaccines prevent; antivirals treat. They are virus-specific — one does not cover all viruses.',
  },
  {
    id: 'antifungals-general',
    topics: ['antifungal', 'antifungals', 'fungal', 'fungus', 'candida', 'thrush', 'ringworm', 'fluconazole'],
    text: 'Antifungals target the fungal cell membrane/wall. Azoles (fluconazole, itraconazole) inhibit ergosterol synthesis; polyenes (amphotericin B) bind ergosterol; echinocandins block cell-wall glucan. Azoles notably inhibit liver CYP enzymes, so they interact with many drugs. Superficial infections often respond to topical treatment; invasive fungal infection needs specialist care.',
  },
  {
    id: 'nsaids-anti-inflammatory',
    topics: ['nsaid', 'nsaids', 'anti-inflammatory', 'inflammation', 'ibuprofen', 'naproxen', 'aspirin', 'pain', 'cox'],
    text: 'NSAIDs (ibuprofen, naproxen, diclofenac, aspirin) inhibit COX enzymes, lowering prostaglandins that drive pain, fever, and inflammation. Risks with regular/high use: stomach irritation and ulcers/bleeding, kidney strain, raised blood pressure, and fluid retention. Caution with heart, kidney, or ulcer disease, in older adults, and alongside blood thinners. Take with food; use the lowest effective dose for the shortest time.',
  },
  {
    id: 'corticosteroids',
    topics: ['corticosteroid', 'steroid', 'steroids', 'prednisolone', 'prednisone', 'dexamethasone', 'inflammation', 'immunosuppressant'],
    text: 'Corticosteroids (prednisolone, dexamethasone) are powerful anti-inflammatories and immune suppressants used across many conditions. Longer courses risk raised blood sugar, bone thinning, weight gain, mood change, infection risk, and adrenal suppression — so they should not be stopped abruptly after prolonged use; they are tapered under medical supervision.',
  },
  {
    id: 'paracetamol-safety',
    topics: ['paracetamol', 'acetaminophen', 'tylenol', 'panadol', 'fever', 'pain', 'liver'],
    text: 'Paracetamol (acetaminophen) is safe and effective for pain and fever at recommended doses, but overdose causes serious liver injury. Never exceed the labeled maximum, watch for the same ingredient hidden in combination cold/flu products, and avoid heavy alcohol use with it. It is gentler on the stomach and kidneys than NSAIDs.',
  },
  {
    id: 'ors-dehydration',
    topics: ['dehydration', 'diarrhea', 'diarrhoea', 'rehydration', 'ors', 'cholera', 'vomiting', 'fluids'],
    text: 'Oral rehydration solution (ORS) — clean water with the correct balance of salt and sugar (WHO formula) — is the primary, life-saving treatment for dehydration from diarrhoea. It works because glucose helps the gut absorb sodium and water together. Severe dehydration (lethargy, sunken eyes, no urine, unable to drink) needs urgent medical care and possibly IV fluids.',
  },

  // ── Diabetes ────────────────────────────────────────────────────────────────
  {
    id: 'diabetes-overview',
    topics: ['diabetes', 'blood sugar', 'glucose', 'type 2 diabetes', 'type 1 diabetes', 'insulin', 'hyperglycemia', 'anti-diabetic'],
    text: 'Type 1 diabetes: the body makes little/no insulin — insulin treatment is essential. Type 2 diabetes: the body resists insulin and/or makes too little — managed with diet, physical activity, weight, and medicines (metformin usually first-line). Good long-term control lowers risk of eye, kidney, nerve, and heart damage. Low blood sugar (hypoglycaemia) signs: shakiness, sweating, confusion — treat quickly with fast sugar.',
  },
  {
    id: 'metformin',
    topics: ['metformin', 'biguanide', 'diabetes', 'blood sugar', 'insulin resistance'],
    text: 'Metformin is first-line for type 2 diabetes. Mechanism: activates AMPK, reduces glucose production by the liver, and improves insulin sensitivity; it rarely causes hypoglycaemia on its own. Common effect: GI upset (often eases with slow titration or extended-release); long-term use can lower vitamin B12. Avoid or use caution in significant kidney or liver impairment (rare risk of lactic acidosis).',
  },

  // ── Plant-derived compounds (with honest evidence + safety) ─────────────────
  {
    id: 'plant-drugs-origin',
    topics: ['plant', 'herbal', 'natural', 'phytochemical', 'extract', 'traditional medicine', 'botanical'],
    text: 'Many mainstream drugs come from plants: aspirin (willow bark salicylates), artemisinin for malaria (sweet wormwood), paclitaxel for cancer (Pacific yew), morphine (opium poppy), digoxin (foxglove), quinine (cinchona bark). This shows plants are a serious source of medicine — AND that "natural" does not mean safe: potency varies by plant/preparation, and plant compounds have real doses, toxicities, and drug interactions.',
  },
  {
    id: 'berberine',
    topics: ['berberine', 'berberis', 'goldenseal', 'blood sugar', 'diabetes', 'cholesterol', 'ampk'],
    text: 'Berberine is a plant alkaloid (from Berberis and related plants) studied for blood sugar and cholesterol. Mechanism overlaps metformin: it activates AMPK. Evidence: several small/medium trials are promising but of limited quality. Safety: it inhibits CYP liver enzymes (many drug interactions), can add to the glucose-lowering of diabetes drugs (hypoglycaemia risk), commonly causes GI upset, and should be avoided in pregnancy and in infants. Discuss with a clinician before combining with prescription medicines.',
  },
  {
    id: 'curcumin-turmeric',
    topics: ['curcumin', 'turmeric', 'inflammation', 'antioxidant', 'anti-inflammatory'],
    text: 'Curcumin (the main active in turmeric) shows anti-inflammatory and antioxidant activity in lab studies (e.g. inhibiting NF-κB signalling). Human evidence is mixed and its oral bioavailability is poor (often combined with piperine to absorb better). Culinary amounts are generally safe; high-dose supplements may interact with blood thinners and can cause GI upset.',
  },
  {
    id: 'garlic-allicin',
    topics: ['garlic', 'allicin', 'antibacterial', 'antimicrobial', 'blood pressure', 'cholesterol'],
    text: 'Garlic contains allicin (formed when crushed), which has antibacterial and antioxidant activity in the lab and modest effects on blood pressure and cholesterol in some human studies. It is not a substitute for antibiotics in a real infection. High doses can thin the blood — caution before surgery or with anticoagulants.',
  },

  // ── Cancer (framing + safety, no false cures) ───────────────────────────────
  {
    id: 'cancer-treatment-overview',
    topics: ['cancer', 'tumor', 'tumour', 'oncology', 'chemotherapy', 'anti-cancer', 'immunotherapy', 'malignant'],
    text: 'Cancer is many different diseases. Main treatments: surgery, chemotherapy (hits rapidly dividing cells), radiotherapy, targeted therapy (blocks a specific driver molecule in the tumour), and immunotherapy (e.g. checkpoint inhibitors that release the immune system to attack the cancer). Treatment is chosen by cancer type, stage, and the person, and is directed by an oncology team. No single herb or supplement is a proven cure for cancer; some can interfere with real treatment — always tell the oncology team about anything taken.',
  },
]

/**
 * Find the notes most relevant to a question. Simple, fast keyword scoring — no
 * network, no model. Returns a compact string (or '' if nothing matches).
 */
export function retrieveKnowledge(query, max = 3) {
  const q = ' ' + String(query || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ') + ' '
  if (q.trim().length < 3) return ''
  const scored = []
  for (const k of KNOWLEDGE) {
    let s = 0
    for (const t of k.topics) {
      const term = t.toLowerCase()
      if (q.includes(' ' + term + ' ') || q.includes(' ' + term)) s += term.length + 2 // specific phrase match
    }
    if (s > 0) scored.push({ k, s })
  }
  scored.sort((a, b) => b.s - a.s)
  const top = scored.slice(0, max)
  if (!top.length) return ''
  return top.map((x) => '- ' + x.k.text).join('\n')
}
