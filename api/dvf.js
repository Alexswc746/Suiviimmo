export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface, type_local = 'Appartement' } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xzkzzxgkoxipmkbxynfq.supabase.co'
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  const surfNum = surface ? parseFloat(surface) : null

  try {
    // Étape 1 — Géocoder l'adresse
    const geoRes = await fetch(
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&limit=1`
    )
    if (!geoRes.ok) throw new Error('Geocodage impossible')
    const geoData = await geoRes.json()

    if (!geoData.features || geoData.features.length === 0) {
      return res.status(200).json({ error: 'Adresse introuvable', dvf: null })
    }

    const feature = geoData.features[0]
    const [lng, lat] = feature.geometry.coordinates
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode
    const codeInsee = feature.properties.citycode

    console.log('Geocodé:', ville, lat, lng)

    // Étape 2 — Interroger Supabase DVF par rayon GPS (500m)
    // Utilise la fonction RPC PostGIS qu'on va créer
    const dvfRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/dvf_par_rayon`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        },
        body: JSON.stringify({
          p_lat: lat,
          p_lon: lng,
          p_rayon: 500,
          p_type: type_local
        })
      }
    )

    if (!dvfRes.ok) {
      const err = await dvfRes.text()
      throw new Error(`Supabase DVF error: ${err}`)
    }

    const transactions = await dvfRes.json()
    console.log('Transactions trouvées:', transactions.length)

    if (!transactions || transactions.length < 3) {
      // Fallback rayon 1000m
      const dvfRes2 = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/dvf_par_rayon`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({
            p_lat: lat,
            p_lon: lng,
            p_rayon: 1500,
            p_type: type_local
          })
        }
      )
      const transactions2 = await dvfRes2.json()
      if (!transactions2 || transactions2.length < 3) {
        return res.status(200).json({
          error: 'Pas assez de ventes comparables dans ce secteur',
          dvf: null,
          geo: { lat, lng, ville, codePostal, codeInsee }
        })
      }
      return calculerResultat(transactions2, surfNum, ville, codePostal, codeInsee, lat, lng, res)
    }

    return calculerResultat(transactions, surfNum, ville, codePostal, codeInsee, lat, lng, res)

  } catch (err) {
    console.error('DVF error:', err.message)
    return res.status(200).json({ error: err.message, dvf: null })
  }
}

function calculerResultat(transactions, surfNum, ville, codePostal, codeInsee, lat, lng, res) {
  const prixM2List = transactions
    .map(t => t.prix_m2)
    .filter(p => p && p > 500 && p < 25000)
    .sort((a, b) => a - b)

  if (prixM2List.length === 0) {
    return res.status(200).json({ error: 'Données insuffisantes', dvf: null })
  }

  const avgM2 = Math.round(prixM2List[Math.floor(prixM2List.length / 2)])
  const est = surfNum ? Math.round(avgM2 * surfNum) : null

  console.log(`DVF: ${avgM2}€/m² — ${prixM2List.length} ventes comparables`)

  return res.status(200).json({
    dvf: {
      avgM2,
      medianM2: avgM2,
      est,
      comp: prixM2List.length,
      conf: prixM2List.length >= 10 ? 'bonne' : 'indicative',
      date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
      samples: transactions.slice(0, 5).map(t => ({
        d: t.date_mutation,
        s: t.surface_reelle_bati,
        p: t.valeur_fonciere,
        m: t.prix_m2
      }))
    },
    geo: { lat, lng, ville, codePostal, codeInsee }
  })
}
