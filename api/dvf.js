export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

  try {
    // Étape 1 — Géocoder l'adresse
    const geoRes = await fetch(
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&limit=1`
    )
    if (!geoRes.ok) throw new Error('Géocodage impossible')
    const geoData = await geoRes.json()

    if (!geoData.features || geoData.features.length === 0) {
      return res.status(200).json({ error: 'Adresse introuvable', dvf: null })
    }

    const feature = geoData.features[0]
    const [lng, lat] = feature.geometry.coordinates
    const codeInsee = feature.properties.citycode
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode

    // Étape 2 — API DVF Etalab (la plus fiable et maintenue)
    let records = []

    const dvfPlusRes = await fetch(
      `https://api.dvf.etalab.gouv.fr/api/geoapi/mutations/?` +
      `code_commune=${codeInsee}&type_local=Appartement&` +
      `fields=valeur_fonciere,surface_reelle_bati,date_mutation&` +
      `ordering=-date_mutation&page_size=40`,
      { headers: { 'Accept': 'application/json' } }
    )
    if (dvfPlusRes.ok) {
      const dvfPlusData = await dvfPlusRes.json()
      records = dvfPlusData.results || []
    }

    // Fallback — API tabular data.gouv.fr
    if (records.length === 0) {
      const fallbackRes = await fetch(
        `https://tabular-api.data.gouv.fr/api/resources/90a98de0-f562-4328-aa16-fe0dd1dca60f/data/?` +
        `code_commune__exact=${codeInsee}&nature_mutation__exact=Vente&type_local__exact=Appartement&page_size=30`,
        { headers: { 'Accept': 'application/json' } }
      )
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json()
        records = fallbackData.data || []
      }
    }

    if (records.length === 0) {
      return res.status(200).json({
        error: 'Aucune vente trouvée pour cette commune',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Normaliser les champs
    const normalize = (r) => ({
      prix: parseFloat(r.valeur_fonciere || r.prix || 0),
      surface: parseFloat(r.surface_reelle_bati || r.surface || 0),
      date: r.date_mutation || r.date || ''
    })

    const surfNum = surface ? parseFloat(surface) : null
    const normalized = records.map(normalize).filter(r => r.prix > 50000 && r.surface > 10)

    const filtered = surfNum
      ? normalized.filter(r => r.surface >= surfNum * 0.7 && r.surface <= surfNum * 1.3)
      : normalized

    const ventes = (filtered.length >= 3 ? filtered : normalized).slice(0, 15)

    if (ventes.length === 0) {
      return res.status(200).json({
        error: 'Données insuffisantes',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    const prixM2List = ventes.map(v => v.prix / v.surface)
    const avgM2 = Math.round(prixM2List.reduce((a, b) => a + b, 0) / prixM2List.length)
    const estValeur = surfNum ? Math.round(avgM2 * surfNum) : null

    const samples = ventes.slice(0, 5).map(v => ({
      d: v.date ? new Date(v.date).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }) : '',
      s: Math.round(v.surface),
      p: Math.round(v.prix),
      m: Math.round(v.prix / v.surface)
    }))

    return res.status(200).json({
      dvf: { avgM2, est: estValeur, comp: ventes.length,
        conf: ventes.length >= 5 ? 'bonne' : 'indicative',
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        samples },
      geo: { lat, lng, ville, codePostal, codeInsee }
    })

  } catch (err) {
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
