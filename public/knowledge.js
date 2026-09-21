/**
 * NORIA KNOWLEDGE BASE (Body-side, free, zero engine risk).
 *
 * Curated, vetted reference notes. For each question, retrieveKnowledge() finds
 * the most relevant notes and the app injects them into the prompt as
 * "[background knowledge]" — so Noria answers GROUNDED in these notes instead of
 * guessing. The Noria Engine is never modified; this is pure client context.
 *
 * These notes are deliberately TEXTBOOK-LEVEL and CONSERVATIVE: mechanisms,
 * drug classes, evidence honesty, and safety — NOT prescriptive doses to
 * self-treat serious disease. Doses/treatment decisions belong to a clinician.
 *
 * ── HOW TO ADD MORE ───────────────────────────────────────────────────────────
 * Append entries: { id, topics: [keywords], text: 'the accurate fact' }.
 * Keep it accurate, concise, safety-aware; cite a source in the text if you have
 * one. Anything added here immediately grounds Noria's answers.
 */

import { FDA_NOTES } from './knowledge-fda.js'

export const KNOWLEDGE = [
  // ═══════════════ GENERAL PRINCIPLES & SAFETY ═══════════════
  {
    id: 'antibiotics-resistance',
    topics: ['antibiotic', 'antibiotics', 'antibacterial', 'bacteria', 'bacterial', 'resistance', 'amr'],
    text: 'Antibiotics treat bacterial infections only — not viruses (colds, flu, most sore throats). Misuse and unfinished courses drive antibiotic resistance, a major global threat. Take exactly as prescribed and never share or reuse antibiotics. Classes act differently: penicillins/cephalosporins block cell-wall building; macrolides/tetracyclines/aminoglycosides block protein synthesis; fluoroquinolones block DNA replication; sulfonamides block folate synthesis.',
  },
  {
    id: 'penicillin-allergy',
    topics: ['penicillin allergy', 'allergic to penicillin', 'amoxicillin allergy', 'drug allergy', 'anaphylaxis'],
    text: 'A true penicillin allergy can cause rash, or rarely anaphylaxis (swelling, breathing trouble, collapse) — a medical emergency needing adrenaline/epinephrine and urgent care. Many people labelled "penicillin allergic" are not truly allergic; this should be assessed by a clinician because it affects which antibiotics can be used. Always report drug allergies before any prescription.',
  },
  {
    id: 'antivirals-general',
    topics: ['antiviral', 'antivirals', 'virus', 'viral', 'influenza', 'flu', 'herpes', 'covid', 'coronavirus'],
    text: 'Antivirals interrupt steps of viral replication (entry, genome copying, or assembly) rather than "killing" viruses the way antibiotics kill bacteria. Examples: oseltamivir inhibits influenza neuraminidase; acyclovir blocks herpes DNA polymerase; many work best started early. Vaccines prevent; antivirals treat. They are virus-specific — one does not cover all viruses.',
  },
  {
    id: 'antifungals-general',
    topics: ['antifungal', 'antifungals', 'fungal', 'fungus', 'candida', 'thrush', 'ringworm', 'fluconazole', 'terbinafine'],
    text: 'Antifungals target the fungal membrane/wall. Azoles (fluconazole, itraconazole) inhibit ergosterol synthesis (CYP51); polyenes (amphotericin B) bind ergosterol to form pores; allylamines (terbinafine) block an earlier ergosterol step; echinocandins block cell-wall glucan. Azoles strongly inhibit liver CYP enzymes, so they interact with many drugs. Superficial infections often respond to topical treatment; invasive infection needs specialist care.',
  },
  {
    id: 'antiseptics-disinfectants',
    topics: ['antiseptic', 'disinfectant', 'hand sanitizer', 'alcohol gel', 'chlorhexidine', 'iodine', 'bleach', 'wound cleaning'],
    text: 'Antiseptics are used on skin (alcohol 60–70%, chlorhexidine, povidone-iodine); disinfectants clean surfaces (bleach/hypochlorite). Alcohol hand rub and soap-and-water are frontline infection control. Never drink or inject disinfectants. For wounds, clean water plus mild antiseptic is usually enough; deep, dirty, or animal-bite wounds need medical review (and tetanus cover).',
  },
  {
    id: 'vaccines-immunization',
    topics: ['vaccine', 'vaccines', 'vaccination', 'immunization', 'immunisation', 'immunity', 'herd immunity'],
    text: 'Vaccines train the immune system to recognise a pathogen in advance, so real infection is prevented or made milder. Types include inactivated, live-attenuated, subunit, mRNA, and viral-vector. High community coverage protects those who cannot be vaccinated (herd immunity). Vaccines are among the most effective, well-studied public-health tools; follow the local schedule and a clinician for individual advice.',
  },
  {
    id: 'immune-system-basics',
    topics: ['immune system', 'immunity', 'white blood cells', 'antibodies', 'inflammation', 'infection defense'],
    text: 'Innate immunity is the fast, general first line (barriers, neutrophils, macrophages, inflammation). Adaptive immunity is slower but specific and remembers: B-cells make antibodies, T-cells kill infected cells and coordinate the response. Inflammation (redness, heat, swelling, pain) is the immune response mobilising — helpful acutely, harmful when chronic.',
  },

  // ═══════════════ PAIN, FEVER & INFLAMMATION ═══════════════
  {
    id: 'nsaids-anti-inflammatory',
    topics: ['nsaid', 'nsaids', 'anti-inflammatory', 'inflammation', 'ibuprofen', 'naproxen', 'diclofenac', 'aspirin', 'cox', 'pain'],
    text: 'NSAIDs (ibuprofen, naproxen, diclofenac, aspirin) inhibit COX enzymes, lowering prostaglandins that drive pain, fever, and inflammation. Risks with regular/high use: stomach irritation, ulcers and bleeding, kidney strain, raised blood pressure, fluid retention. Caution with heart, kidney, or ulcer disease, in older adults, in pregnancy, and with blood thinners. Take with food; lowest effective dose for the shortest time.',
  },
  {
    id: 'paracetamol-safety',
    topics: ['paracetamol', 'acetaminophen', 'tylenol', 'panadol', 'fever', 'liver', 'overdose'],
    text: 'Paracetamol (acetaminophen) treats pain and fever and is gentler on the stomach and kidneys than NSAIDs — but overdose causes severe, sometimes fatal liver injury. Never exceed the labeled maximum, watch for the same ingredient hidden in combination cold/flu products, and avoid heavy alcohol. Suspected overdose is an emergency (antidote N-acetylcysteine works best given early).',
  },
  {
    id: 'opioids-safety',
    topics: ['opioid', 'opioids', 'morphine', 'codeine', 'tramadol', 'oxycodone', 'fentanyl', 'painkiller', 'addiction', 'overdose'],
    text: 'Opioids (morphine, codeine, tramadol, oxycodone, fentanyl) relieve moderate-to-severe pain by acting on opioid receptors. Serious risks: constipation, sedation, tolerance, dependence/addiction, and life-threatening slowed breathing in overdose (reversible with naloxone). Dangerous combined with alcohol or sedatives. Use only as prescribed, never share, and store safely away from children.',
  },
  {
    id: 'corticosteroids',
    topics: ['corticosteroid', 'steroid', 'steroids', 'prednisolone', 'prednisone', 'dexamethasone', 'hydrocortisone', 'immunosuppressant'],
    text: 'Corticosteroids (prednisolone, dexamethasone, hydrocortisone) are powerful anti-inflammatories and immune suppressants. Longer courses risk raised blood sugar, bone thinning, weight gain, mood change, stomach ulcers, and infection risk, and can suppress the adrenal glands — so after prolonged use they must be tapered, not stopped suddenly. Inhaled/topical forms have far fewer whole-body effects.',
  },

  // ═══════════════ HEART & CIRCULATION ═══════════════
  {
    id: 'hypertension',
    topics: ['hypertension', 'high blood pressure', 'blood pressure', 'bp'],
    text: 'High blood pressure usually has no symptoms but raises the risk of stroke, heart attack, and kidney disease. Lifestyle helps a lot: less salt, more activity, healthy weight, limit alcohol, no smoking, manage stress. Medicines used include ACE inhibitors/ARBs, calcium-channel blockers, and diuretics. Very high readings with headache, chest pain, vision change, or breathlessness need urgent care.',
  },
  {
    id: 'ace-arb',
    topics: ['ace inhibitor', 'ramipril', 'lisinopril', 'enalapril', 'arb', 'losartan', 'valsartan', 'blood pressure', 'heart failure'],
    text: 'ACE inhibitors (…-pril: ramipril, lisinopril) and ARBs (…-sartan: losartan, valsartan) relax blood vessels by blocking the renin-angiotensin system; used for high blood pressure, heart failure, and kidney protection (especially in diabetes). ACE inhibitors can cause a dry cough (ARBs usually don\'t). Both can raise potassium and affect the kidneys, and are avoided in pregnancy.',
  },
  {
    id: 'beta-blockers',
    topics: ['beta blocker', 'beta-blocker', 'propranolol', 'atenolol', 'bisoprolol', 'metoprolol', 'heart rate'],
    text: 'Beta-blockers (…-olol: bisoprolol, atenolol, propranolol) slow the heart and reduce its workload — used for some heart conditions, heart failure, angina, and certain arrhythmias, and sometimes for tremor/anxiety. They can cause tiredness, cold hands, and slow pulse; use caution in asthma; do not stop suddenly (rebound effects).',
  },
  {
    id: 'statins',
    topics: ['statin', 'statins', 'atorvastatin', 'simvastatin', 'rosuvastatin', 'cholesterol', 'ldl'],
    text: 'Statins (atorvastatin, simvastatin, rosuvastatin) lower LDL ("bad") cholesterol by inhibiting HMG-CoA reductase in the liver, cutting heart-attack and stroke risk. Usually well tolerated; possible muscle aches (rarely serious muscle breakdown) and liver enzyme changes. Grapefruit can raise levels of some statins. Report unexplained muscle pain/weakness.',
  },
  {
    id: 'anticoagulants-antiplatelets',
    topics: ['anticoagulant', 'blood thinner', 'warfarin', 'heparin', 'doac', 'apixaban', 'rivaroxaban', 'antiplatelet', 'clopidogrel', 'aspirin', 'clot'],
    text: 'Blood thinners reduce clots. Antiplatelets (aspirin, clopidogrel) stop platelets clumping; anticoagulants (warfarin, heparin, and DOACs like apixaban/rivaroxaban) slow the clotting cascade. Main risk is bleeding — report unusual bruising, blood in urine/stool, or heavy/persistent bleeding. Warfarin needs regular blood-test (INR) monitoring and interacts with many foods/drugs; DOACs need less monitoring.',
  },

  // ═══════════════ STOMACH & GUT ═══════════════
  {
    id: 'acid-reflux-ppi',
    topics: ['reflux', 'gerd', 'heartburn', 'acid', 'ppi', 'omeprazole', 'antacid', 'ulcer', 'h2 blocker', 'indigestion'],
    text: 'Acid reflux/GERD is stomach acid rising into the gullet. Antacids neutralise acid fast (short relief); H2-blockers (famotidine) reduce acid; PPIs (omeprazole, esomeprazole) strongly cut acid and heal ulcers. Long-term PPI use can lower magnesium/B12 and slightly raise some infection risks. Alarm signs needing review: trouble swallowing, weight loss, vomiting blood, or black stools.',
  },
  {
    id: 'ors-dehydration',
    topics: ['dehydration', 'diarrhea', 'diarrhoea', 'rehydration', 'ors', 'cholera', 'vomiting', 'fluids'],
    text: 'Oral rehydration solution (ORS) — clean water with the correct balance of salt and sugar (WHO formula) — is the primary, life-saving treatment for dehydration from diarrhoea, because glucose helps the gut absorb sodium and water together. Zinc supplementation shortens childhood diarrhoea. Severe dehydration (lethargy, sunken eyes, no urine, unable to drink) needs urgent care and possibly IV fluids.',
  },
  {
    id: 'antiemetics-laxatives',
    topics: ['nausea', 'vomiting', 'antiemetic', 'ondansetron', 'metoclopramide', 'constipation', 'laxative', 'fibre'],
    text: 'Nausea/vomiting: antiemetics act on different triggers (ondansetron blocks serotonin, metoclopramide speeds gastric emptying). Constipation: first-line is fluids, fibre, and activity; laxatives include bulking agents, osmotics (lactulose, PEG), and stimulants (senna) for short-term use. Persistent change in bowel habit, or blood in stool, should be reviewed.',
  },

  // ═══════════════ LUNGS & ALLERGY ═══════════════
  {
    id: 'asthma-copd',
    topics: ['asthma', 'copd', 'inhaler', 'wheeze', 'bronchodilator', 'salbutamol', 'albuterol', 'breathing', 'reliever', 'preventer'],
    text: 'Asthma and COPD narrow the airways. Relievers (SABA, e.g. salbutamol/albuterol) open airways quickly for symptoms; preventers (inhaled corticosteroids ± long-acting bronchodilators) reduce underlying inflammation and are taken regularly. Good inhaler technique matters. Severe breathlessness, a reliever not working, or blue lips is an emergency — seek urgent help.',
  },
  {
    id: 'antihistamines-allergy',
    topics: ['antihistamine', 'allergy', 'allergic', 'hay fever', 'rhinitis', 'cetirizine', 'loratadine', 'hives', 'itching', 'histamine'],
    text: 'Antihistamines block histamine to ease allergy symptoms (sneezing, itch, hives, runny nose). Newer ones (cetirizine, loratadine, fexofenadine) cause little drowsiness; older ones (diphenhydramine, chlorphenamine) are sedating. For allergic rhinitis, steroid nasal sprays are very effective. Severe allergy with swelling or breathing difficulty (anaphylaxis) needs adrenaline and emergency care.',
  },
  {
    id: 'cold-vs-flu',
    topics: ['cold', 'common cold', 'flu', 'influenza', 'cough', 'sore throat', 'runny nose', 'fever'],
    text: 'Common cold: gradual, milder, mostly runny nose/sore throat, little fever — caused by many viruses; antibiotics do NOT help. Flu (influenza): sudden high fever, body aches, exhaustion — can be serious in the elderly, pregnant, or chronically ill. Both are mostly managed with rest, fluids, and paracetamol/ibuprofen. See a clinician for breathing difficulty, chest pain, confusion, or symptoms that worsen after initial improvement.',
  },

  // ═══════════════ DIABETES & HORMONES ═══════════════
  {
    id: 'diabetes-overview',
    topics: ['diabetes', 'blood sugar', 'glucose', 'type 2 diabetes', 'type 1 diabetes', 'insulin', 'hyperglycemia', 'hypoglycemia', 'anti-diabetic'],
    text: 'Type 1 diabetes: little/no insulin is made — insulin is essential. Type 2: the body resists insulin and/or makes too little — managed with diet, activity, weight, and medicines (metformin usually first-line). Good long-term control lowers eye, kidney, nerve, and heart damage. Low sugar (hypoglycaemia) — shakiness, sweating, confusion — treat fast with sugar. Very high sugar with vomiting, deep breathing, or drowsiness is an emergency.',
  },
  {
    id: 'metformin',
    topics: ['metformin', 'biguanide', 'diabetes', 'blood sugar', 'insulin resistance', 'pcos'],
    text: 'Metformin is first-line for type 2 diabetes (and used in PCOS). Mechanism: activates AMPK, reduces glucose production by the liver, and improves insulin sensitivity; it rarely causes hypoglycaemia alone. Common effect: GI upset (eases with slow titration or extended-release); long-term use can lower vitamin B12. Caution in significant kidney or liver impairment (rare lactic-acidosis risk).',
  },
  {
    id: 'diabetes-drug-classes',
    topics: ['sulfonylurea', 'gliclazide', 'sglt2', 'empagliflozin', 'glp-1', 'semaglutide', 'insulin types', 'dpp-4', 'anti-diabetic'],
    text: 'Beyond metformin: sulfonylureas (gliclazide) push the pancreas to release insulin (can cause hypoglycaemia and weight gain); SGLT2 inhibitors (…-flozin) make kidneys excrete glucose and protect heart/kidneys; GLP-1 agonists (…-tide, e.g. semaglutide) lower sugar, curb appetite, and aid weight loss; DPP-4 inhibitors (…-gliptin) are weight-neutral. Insulin ranges from rapid to long-acting. Choice is individualised by a clinician.',
  },
  {
    id: 'thyroid',
    topics: ['thyroid', 'hypothyroid', 'hyperthyroid', 'levothyroxine', 'tsh', 'goiter', 'metabolism'],
    text: 'The thyroid sets metabolic pace. Underactive (hypothyroidism): tiredness, weight gain, cold intolerance — treated with levothyroxine (a T4 replacement, taken on an empty stomach, dose guided by TSH blood tests). Overactive (hyperthyroidism): weight loss, palpitations, heat intolerance, anxiety. Both need blood tests and clinician-guided treatment.',
  },

  // ═══════════════ INFECTIONS (SPECIFIC) ═══════════════
  {
    id: 'malaria',
    topics: ['malaria', 'mosquito', 'plasmodium', 'artemisinin', 'act', 'fever tropical'],
    text: 'Malaria is caused by Plasmodium parasites spread by night-biting Anopheles mosquitoes; fever, chills, and flu-like illness after exposure in an endemic area is malaria until proven otherwise — test promptly. First-line treatment is artemisinin-based combination therapy (ACT); artemisinin comes from sweet wormwood (Artemisia annua). Prevention: bed nets, repellent, and prophylaxis for travellers. Severe malaria is a medical emergency.',
  },
  {
    id: 'tuberculosis',
    topics: ['tuberculosis', 'tb', 'cough blood', 'night sweats', 'lung infection'],
    text: 'Tuberculosis (TB) is a bacterial infection (Mycobacterium tuberculosis), usually of the lungs, spread by airborne droplets; classic signs: cough over 2–3 weeks, sometimes with blood, fever, night sweats, and weight loss. It is curable with a supervised multi-drug course over months — finishing the full course is essential to prevent drug-resistant TB. Suspected TB needs medical testing.',
  },
  {
    id: 'hiv-basics',
    topics: ['hiv', 'aids', 'art', 'antiretroviral', 'prep', 'immune'],
    text: 'HIV attacks CD4 immune cells; untreated it can progress to AIDS. Modern antiretroviral therapy (ART) suppresses the virus so people live long, healthy lives, and when the virus is undetectable it is untransmittable (U=U). Prevention includes condoms, PrEP (pre-exposure medicine), safe injecting, and testing. Care must be guided by an HIV clinician.',
  },
  {
    id: 'uti',
    topics: ['uti', 'urinary tract infection', 'cystitis', 'bladder infection', 'burning urine'],
    text: 'Urinary tract infections (usually bacterial, often E. coli) cause burning on urination, frequency, urgency, and lower-tummy discomfort; they generally need antibiotics. Warning signs of a kidney infection or sepsis — high fever, back/flank pain, vomiting, confusion — need urgent care. Hydration and prompt urination help; recurrent UTIs should be reviewed.',
  },

  // ═══════════════ BLOOD & NUTRITION ═══════════════
  {
    id: 'anemia-iron',
    topics: ['anemia', 'anaemia', 'iron', 'ferritin', 'hemoglobin', 'tired', 'pale', 'b12', 'folate'],
    text: 'Anaemia (low haemoglobin) causes tiredness, pallor, and breathlessness. The commonest cause is iron deficiency (poor intake, blood loss, or heavy periods) — iron-rich foods (red meat, legumes, leafy greens) plus vitamin C aid absorption; supplements when needed. B12/folate deficiency causes another type. Anaemia is a sign, not a diagnosis — the cause (including hidden bleeding) should be found.',
  },
  {
    id: 'vitamin-d',
    topics: ['vitamin d', 'sunlight', 'bone health', 'calcium', 'rickets', 'deficiency'],
    text: 'Vitamin D helps the gut absorb calcium for healthy bones and supports muscle and immune function; it is made in skin from sunlight and found in oily fish and fortified foods. Deficiency is common with little sun exposure and can cause bone/muscle problems (rickets in children). Supplements help those at risk, but very high doses are harmful (raise calcium) — follow local guidance.',
  },
  {
    id: 'vitamins-minerals',
    topics: ['vitamin', 'vitamins', 'mineral', 'supplement', 'vitamin c', 'zinc', 'folate', 'nutrition', 'deficiency'],
    text: 'A balanced diet usually supplies vitamins/minerals. Key roles: vitamin C (immune function, collagen, iron absorption), zinc (immunity, wound healing, shortens some colds), folate (vital before/early pregnancy to prevent neural-tube defects), B12 (nerves and blood), iodine (thyroid). More is not better — fat-soluble vitamins (A, D, E, K) and some minerals are toxic in excess.',
  },

  // ═══════════════ PLANT / NATURAL COMPOUNDS (evidence + safety) ═══════════════
  {
    id: 'plant-drugs-origin',
    topics: ['plant', 'herbal', 'natural', 'phytochemical', 'extract', 'traditional medicine', 'botanical', 'concoction'],
    text: 'Many mainstream drugs come from plants: aspirin (willow salicylates), artemisinin for malaria (sweet wormwood), paclitaxel for cancer (Pacific yew), morphine (opium poppy), digoxin (foxglove), quinine (cinchona). So plants are a serious source of medicine — AND "natural" does not mean safe: potency varies by plant/preparation, effects are dose-dependent, and herb–drug interactions are real. Home "concoctions" have unknown, variable, sometimes toxic doses.',
  },
  {
    id: 'berberine',
    topics: ['berberine', 'berberis', 'goldenseal', 'blood sugar', 'diabetes', 'cholesterol', 'ampk'],
    text: 'Berberine is a plant alkaloid (Berberis and related plants) studied for blood sugar and cholesterol; mechanism overlaps metformin (activates AMPK). Evidence: several small/medium trials are promising but of limited quality. Safety: inhibits CYP liver enzymes (many interactions), can add to diabetes drugs\' glucose-lowering (hypoglycaemia), commonly causes GI upset, and is avoided in pregnancy and infants. Discuss with a clinician before combining with prescriptions.',
  },
  {
    id: 'curcumin-turmeric',
    topics: ['curcumin', 'turmeric', 'inflammation', 'antioxidant', 'anti-inflammatory', 'joint'],
    text: 'Curcumin (turmeric\'s main active) shows anti-inflammatory and antioxidant activity in lab studies (e.g. inhibiting NF-κB). Human evidence is mixed and oral absorption is poor (often paired with piperine/black pepper to absorb better). Culinary amounts are safe; high-dose supplements may interact with blood thinners and can upset the stomach.',
  },
  {
    id: 'ginger',
    topics: ['ginger', 'nausea', 'morning sickness', 'motion sickness', 'digestion', 'anti-inflammatory'],
    text: 'Ginger has reasonable evidence for easing nausea (pregnancy, motion sickness, post-op) and mild anti-inflammatory effects. Generally safe as food/tea; large supplement doses may thin the blood slightly and cause heartburn. A practical, low-risk option for mild nausea — but persistent vomiting or nausea with red flags needs medical review.',
  },
  {
    id: 'garlic-allicin',
    topics: ['garlic', 'allicin', 'antibacterial', 'antimicrobial', 'blood pressure', 'cholesterol'],
    text: 'Garlic contains allicin (formed when crushed), with antibacterial/antioxidant activity in the lab and modest effects on blood pressure and cholesterol in some human studies. It is not a substitute for antibiotics in a real infection. High doses can thin the blood — caution before surgery or with anticoagulants.',
  },
  {
    id: 'honey',
    topics: ['honey', 'cough', 'sore throat', 'wound', 'antibacterial'],
    text: 'Honey soothes cough and sore throat and has mild antibacterial properties (used in some medical wound dressings). Do NOT give honey to infants under 1 year (risk of infant botulism). It is sugar, so it affects blood glucose and teeth. A reasonable home comfort for coughs in older children and adults.',
  },
  {
    id: 'green-tea-egcg',
    topics: ['green tea', 'egcg', 'catechin', 'antioxidant', 'metabolism'],
    text: 'Green tea contains catechins (notably EGCG) with antioxidant activity and modest effects on metabolism/heart risk factors in studies. As a drink it is safe for most; very concentrated extract supplements have rarely been linked to liver injury and contain caffeine. Moderation is sensible.',
  },
  {
    id: 'aloe-moringa-neem',
    topics: ['aloe vera', 'aloe', 'moringa', 'neem', 'herbal', 'traditional', 'skin'],
    text: 'Aloe vera gel soothes minor burns and skin irritation (topical); oral aloe latex is a harsh laxative and best avoided. Moringa leaves are nutrient-rich (vitamins, minerals, protein) and a useful food, with early research on blood sugar/inflammation. Neem has traditional antimicrobial use and lab activity, but neem oil can be toxic if swallowed, especially by children. "Traditional use" is a lead, not proof — evidence quality varies and safety still matters.',
  },
  {
    id: 'cinnamon-fenugreek',
    topics: ['cinnamon', 'fenugreek', 'blood sugar', 'diabetes', 'herbal'],
    text: 'Cinnamon and fenugreek are studied for small effects on blood sugar, but trial results are inconsistent and they are not a replacement for diabetes medicine. Note: cassia cinnamon contains coumarin, which in large regular amounts can harm the liver (Ceylon cinnamon has less). Fenugreek can lower sugar additively with diabetes drugs. Tell a clinician before relying on them.',
  },
  {
    id: 'ginkgo-ginseng-ashwagandha',
    topics: ['ginkgo', 'ginseng', 'ashwagandha', 'adaptogen', 'memory', 'stress', 'energy', 'herbal'],
    text: 'Ginkgo biloba (studied for circulation/memory — modest, mixed evidence) can thin the blood (interaction/bleeding risk). Ginseng is used for energy/stress with mixed evidence and can affect blood sugar and blood pressure. Ashwagandha is traditionally used for stress with some supportive small trials, but is avoided in pregnancy and thyroid caution applies. All can interact with medicines — check first.',
  },
  {
    id: 'milk-thistle',
    topics: ['milk thistle', 'silymarin', 'liver', 'hepatoprotective'],
    text: 'Milk thistle (silymarin) is traditionally used for liver health, with antioxidant activity and some supportive but not definitive human evidence. Generally well tolerated. It is not a treatment for serious liver disease or a licence to drink alcohol — real liver problems need medical assessment.',
  },

  // ═══════════════ TRADITIONAL & PROPHETIC REMEDIES (respect + honest evidence) ═══════════════
  {
    id: 'black-seed-nigella',
    topics: ['black seed', 'nigella', 'nigella sativa', 'kalonji', 'habbat', 'thymoquinone', 'prophetic medicine', 'black cumin'],
    text: 'Black seed (Nigella sativa, "habbat al-barakah") is honoured in prophetic and traditional medicine. Modern research on its compound thymoquinone shows anti-inflammatory, antioxidant, and immune-modulating effects in lab and small human studies, with modest signals for blood sugar, blood pressure, and asthma symptoms. It is a valued supportive food and traditional remedy — but not a proven cure for serious disease and not a replacement for treatment. High amounts can lower blood sugar and blood pressure and affect clotting, so take care alongside medicines and before surgery.',
  },
  {
    id: 'dates-fruit',
    topics: ['dates', 'date fruit', 'ajwa', 'palm', 'break fast', 'iftar'],
    text: 'Dates are a nutritious food (fibre, potassium, natural sugars, antioxidants), valued across traditions and scripture and a gentle way to restore energy when breaking a fast. Because they are high in natural sugar, people with diabetes should count them in their carbohydrate intake and eat them in moderation.',
  },
  {
    id: 'olive-oil',
    topics: ['olive oil', 'olive', 'mediterranean diet', 'healthy fat'],
    text: 'Olive oil, honoured in many faith traditions, is a healthy fat rich in monounsaturated fats and antioxidants (polyphenols) and is central to the Mediterranean dietary pattern, which is linked with better heart health. It is a good everyday food — nourishing, not a cure for disease.',
  },
  {
    id: 'fasting',
    topics: ['fasting', 'fast', 'intermittent fasting', 'ramadan', 'abstain food'],
    text: 'Fasting is practised in many faiths and also studied scientifically (intermittent fasting), with some metabolic and self-discipline benefits for many people. It is generally safe for healthy adults, but those with diabetes (especially on insulin or sulfonylureas), pregnancy, kidney disease, eating disorders, or on certain medicines should seek medical advice to fast safely and adjust treatment.',
  },

  // ═══════════════ CANCER ═══════════════
  {
    id: 'cancer-treatment-overview',
    topics: ['cancer', 'tumor', 'tumour', 'oncology', 'chemotherapy', 'anti-cancer', 'immunotherapy', 'malignant', 'radiotherapy'],
    text: 'Cancer is many different diseases where cells grow uncontrollably. Main treatments: surgery, chemotherapy (hits rapidly dividing cells), radiotherapy, targeted therapy (blocks a specific driver molecule in the tumour), and immunotherapy (e.g. checkpoint inhibitors that release the immune system to attack the cancer). Treatment is chosen by cancer type, stage, and the person, directed by an oncology team. No single herb or supplement is a proven cure, and some interfere with treatment — always tell the oncology team about anything taken.',
  },
  {
    id: 'cancer-prevention-screening',
    topics: ['cancer prevention', 'cancer screening', 'mammogram', 'smear', 'colonoscopy', 'warning signs', 'early detection'],
    text: 'Much cancer risk is reducible: don\'t smoke, limit alcohol, healthy weight and diet, physical activity, sun protection, and vaccines (HPV prevents cervical/other cancers; hepatitis B lowers liver cancer). Screening finds cancers early when curable (e.g. cervical smear, breast mammography, bowel screening). See a doctor for warning signs: an unexplained lump, abnormal bleeding, a non-healing sore, persistent cough/hoarseness, changing moles, or unexplained weight loss.',
  },

  // ═══════════════ MENTAL HEALTH & NEURO ═══════════════
  {
    id: 'depression-anxiety',
    topics: ['depression', 'anxiety', 'ssri', 'antidepressant', 'mental health', 'panic', 'sertraline', 'fluoxetine'],
    text: 'Depression and anxiety are common, treatable medical conditions — not weakness. Talking therapies (like CBT), lifestyle, and social support help; medicines such as SSRIs (sertraline, fluoxetine) raise serotonin signalling and take a few weeks to work. They should be started and stopped gradually under guidance. Thoughts of self-harm or suicide are an emergency — contact local crisis services or emergency care immediately.',
  },
  {
    id: 'sleep-hygiene',
    topics: ['sleep', 'insomnia', 'sleep hygiene', 'tired', 'melatonin', 'rest'],
    text: 'Good sleep supports mood, immunity, and metabolism. Sleep hygiene: consistent sleep/wake times, a dark cool quiet room, limit caffeine/alcohol and screens before bed, and daytime activity. Ongoing insomnia responds best to CBT for insomnia rather than long-term sleeping pills (which can cause dependence). Persistent insomnia or loud snoring with daytime sleepiness should be reviewed.',
  },

  // ═══════════════ FIRST AID & EMERGENCIES ═══════════════
  {
    id: 'emergency-warning-signs',
    topics: ['emergency', 'chest pain', 'stroke', 'heart attack', 'difficulty breathing', 'severe bleeding', 'unconscious', 'seizure', 'anaphylaxis'],
    text: 'Call emergency services immediately for: chest pain/pressure, sudden face/arm weakness or slurred speech (stroke — act FAST), severe trouble breathing, heavy uncontrolled bleeding, sudden severe allergic reaction (swelling/breathing difficulty), a first or prolonged seizure, someone unconscious or unresponsive, or suspected poisoning/overdose. Do not "wait and see" with these.',
  },
  {
    id: 'burns-wounds',
    topics: ['burn', 'burns', 'wound', 'cut', 'bleeding', 'first aid', 'scald'],
    text: 'Minor burns: cool under running water ~20 minutes, remove tight items, cover loosely with clean non-stick material; do NOT apply ice, butter, or toothpaste. Bleeding wounds: apply firm direct pressure and elevate. Seek care for large/deep/facial burns, chemical/electrical burns, deep or gaping wounds, animal/human bites, or signs of infection (spreading redness, pus, fever). Keep tetanus vaccination up to date.',
  },
  {
    id: 'choking-cpr',
    topics: ['choking', 'heimlich', 'cpr', 'not breathing', 'first aid', 'resuscitation'],
    text: 'Choking (can\'t speak/breathe): give firm back blows and abdominal thrusts (Heimlich) until it clears; call for help. If someone is unresponsive and not breathing normally, call emergency services and start CPR — push hard and fast in the centre of the chest (~100–120/min), using an AED if available. These are best learned in a hands-on first-aid course.',
  },
  {
    id: 'poisoning',
    topics: ['poison', 'poisoning', 'overdose', 'swallowed', 'toxic', 'ingestion'],
    text: 'Suspected poisoning or overdose: call emergency services or a poison centre right away; have the substance/container ready. Do NOT make the person vomit unless told to by a professional. This includes medicine overdoses (e.g. paracetamol, where the antidote works best early), household chemicals, and toxic plants. Keep medicines and chemicals locked away from children.',
  },

  // ═══════════════ PUBLIC HEALTH & PREVENTION ═══════════════
  {
    id: 'hygiene-prevention',
    topics: ['hygiene', 'hand washing', 'clean water', 'sanitation', 'prevention', 'infection control', 'mosquito'],
    text: 'Simple measures prevent much illness: wash hands with soap (especially before food and after the toilet), drink safe/boiled/treated water, cook and store food safely, and cover coughs. Mosquito-borne disease (malaria, dengue) is reduced with nets, repellent, and removing standing water. Vaccination and safe sanitation are among the highest-impact protections.',
  },
  {
    id: 'healthy-lifestyle',
    topics: ['diet', 'nutrition', 'exercise', 'healthy lifestyle', 'weight', 'fitness', 'wellbeing'],
    text: 'The strongest, cheapest medicine is lifestyle: a varied diet rich in vegetables, fruit, whole grains, legumes, and lean protein with limited salt, sugar, and ultra-processed food; regular activity (about 150 minutes/week moderate plus some strength work); healthy weight; no smoking; limited alcohol; good sleep; and managing stress. These lower risk of heart disease, diabetes, and several cancers.',
  },

  // ═══════════════ AFRICA'S YOUTH & THE CONTINENT'S FUTURE ═══════════════
  {
    id: 'africa-youth-future',
    topics: ['young africans', 'young african', 'african youth', 'youth in africa', 'brain drain', 'japa', 'emigrate', 'emigration', 'leave africa', 'leaving africa', 'stay abroad', 'return home', 'come back home', 'diaspora', 'corrupt leaders', 'corruption in africa', 'future of africa', 'africa future', 'build africa', 'fix africa', 'develop africa', 'africa development'],
    text: "Guidance for young Africans (share it warmly when someone asks about their future, leaving or staying, brain drain, corruption, leadership or building Africa; never as a lecture, and never to shame anyone): Africa's future will be built by its young people, and the strongest foundation is education, real skills and hands-on, real-world learning. Learn to do things that solve real problems (engineering, health, farming, energy, technology, finance, law, teaching, skilled trades) and keep learning for life. Studying or working abroad can be a good way to gain skills, and for some it is unavoidable, but be realistic: some people are not fully recognised or valued abroad, and their talent is needed at home. The most powerful path is to bring skills, savings and networks back: return if you can, or build, invest, mentor and hire at home from wherever you are. Real change also needs citizens of integrity. Take part in public life peacefully and lawfully: vote, join or start civic groups, work inside institutions and improve them, demand transparency and accountability, back honest leaders, and be ready to serve yourself. Corruption, where it exists, ends when honest and capable people fill institutions and citizens insist on accountability through elections, courts, a free press and organised civic action, never through violence. Each person chooses their own path, so encourage without pressure, be honest that change takes years of patient work, and promise no easy results."
  },
]

/**
 * Find the notes most relevant to a question. Simple, fast keyword scoring — no
 * network, no model. Returns a compact string (or '' if nothing matches).
 */
export function retrieveKnowledge(query, max = 3) {
  const q = ' ' + String(query || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ') + ' '
  if (q.trim().length < 3) return ''
  const scored = []
  const CORPUS = KNOWLEDGE.concat(FDA_NOTES) // curated notes + sourced FDA drug labels
  for (const k of CORPUS) {
    let s = 0
    for (const t of k.topics) {
      const term = ' ' + t.toLowerCase() + ' '
      if (q.includes(term)) s += t.length + 3          // whole-phrase match = strong
      else if (t.length >= 5 && q.includes(' ' + t.toLowerCase())) s += t.length // prefix/word-start match
    }
    if (s > 0) scored.push({ k, s })
  }
  scored.sort((a, b) => b.s - a.s)
  const top = scored.slice(0, max)
  if (!top.length) return ''
  return top.map((x) => '- ' + x.k.text).join('\n')
}
