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
    if (!geoRes.ok) throw new Error('Geocodage impossible - statut ' + geoRes.status)
    const geoData = await geoRes.json()

    if (!geoData.features || geoData.features.length === 0) {
      return res.status(200).json({ error: 'Adresse introuvable', dvf: null })
    }

    const feature = geoData.features[0]
    const [lng, lat] = feature.geometry.coordinates
    const codeInsee = feature.properties.citycode
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode

    // Étape 2 — API DVF via Cerema / data.gouv ressource directe
    // Cette URL est stable et maintenue
    const anneeMin = new Date().getFullYear() - 3
    const url = `https://api.data.gouv.fr/api/1/datasets/5c4ae55a634f4117716d5656/resources/`
    
    // Utiliser l'endpoint de recherche géographique DVF
    const dvfUrl = `https://api-dvf.data.gouv.fr/api/v1/departements/${codeInsee.substring(0,2)}/communes/${codeInsee}/mutations?type_local=Appartement&page_size=40`
    
    const dvfRes = await fetch(dvfUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    })

    let records = []
    if (dvfRes.ok) {
      const dvfData = await dvfRes.json()
      records = dvfData.mutations || dvfData.results || dvfData || []
    }

    // Fallback — recherche par coordonnées GPS
    if (records.length === 0) {
      const gpsUrl = `https://api-dvf.data.gouv.fr/api/v1/mutations?lat=${lat}&lon=${lng}&dist=1000&type_local=Appartement&page_size=40`
      const gpsRes = await fetch(gpsUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      })
      if (gpsRes.ok) {
        const gpsData = await gpsRes.json()
        records = gpsData.mutations || gpsData.results || []
      }
    }

    if (records.length === 0) {
      return res.status(200).json({
        error: 'Aucune vente trouvee (code commune: ' + codeInsee + ')',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Normaliser les champs
    const surfNum = surface ? parseFloat(surface) : null
    const normalized = records
      .map(r => ({
        prix: parseFloat(r.valeur_fonciere || r.prix || r.price || 0),
        surface: parseFloat(r.surface_reelle_bati || r.surface || 0),
        date: r.date_mutation || r.date || ''
      }))
      .filter(r => r.prix > 50000 && r.surface > 10)

    const filtered = surfNum
      ? normalized.filter(r => r.surface >= surfNum * 0.7 && r.surface <= surfNum * 1.3)
      : normalized

    const ventes = (filtered.length >= 3 ? filtered : normalized).slice(0, 15)

    if (ventes.length === 0) {
      return res.status(200).json({ error: 'Donnees insuffisantes', dvf: null, geo: { lat, lng, ville, codePostal, codeInsee } })
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
      dvf: {
        avgM2, est: estValeur, comp: ventes.length,
        conf: ventes.length >= 5 ? 'bonne' : 'indicative',
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        samples
      },
      geo: { lat, lng, ville, codePostal, codeInsee }
    })

  } catch (err) {
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
