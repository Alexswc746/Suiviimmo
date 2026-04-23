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
    const geoUrl = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&limit=1`
    const geoRes = await fetch(geoUrl)
    const geoData = await geoRes.json()

    if (!geoData.features || geoData.features.length === 0) {
      return res.status(200).json({ error: 'Adresse introuvable', dvf: null })
    }

    const feature = geoData.features[0]
    const [lng, lat] = feature.geometry.coordinates
    const codeInsee = feature.properties.citycode
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode

    // Étape 2 — Récupérer les ventes DVF autour du bien
    // API DVF — ventes dans la commune sur les 18 derniers mois
    const annee = new Date().getFullYear()
    const dvfUrl = `https://api.data.gouv.fr/api/1/datasets/5c4ae55a634f4117716d5656/`
    
    // Utiliser l'API DVF Etalab directement
    const dvfApiUrl = `https://api.pricehubble.com/api/v1/valuation/property_value`
    
    // On utilise l'API DVF officielle data.gouv
    const dvfRes = await fetch(
      `https://api.data.gouv.fr/api/explore/v2.1/catalog/datasets/demandes-de-valeurs-foncieres/records?` +
      `where=code_commune%3D%22${codeInsee}%22%20AND%20nature_mutation%3D%22Vente%22%20AND%20type_local%3D%22Appartement%22&` +
      `order_by=date_mutation%20DESC&limit=20&select=valeur_fonciere,surface_reelle_bati,date_mutation,adresse_nom_voie`,
      { headers: { 'Accept': 'application/json' } }
    )
    
    if (!dvfRes.ok) {
      return res.status(200).json({ error: 'DVF indisponible', dvf: null, geo: { lat, lng, ville, codePostal } })
    }

    const dvfData = await dvfRes.json()
    const records = dvfData.results || []

    if (records.length === 0) {
      return res.status(200).json({ 
        error: 'Aucune vente trouvée dans ce secteur', 
        dvf: null,
        geo: { lat, lng, ville, codePostal }
      })
    }

    // Filtrer les ventes avec surface proche (±30%) si surface fournie
    const surfNum = surface ? parseFloat(surface) : null
    const filtered = surfNum
      ? records.filter(r => {
          const s = parseFloat(r.surface_reelle_bati)
          return s > 0 && s >= surfNum * 0.7 && s <= surfNum * 1.3
        })
      : records.filter(r => parseFloat(r.surface_reelle_bati) > 0)

    const ventes = (filtered.length >= 3 ? filtered : records)
      .filter(r => parseFloat(r.valeur_fonciere) > 50000 && parseFloat(r.surface_reelle_bati) > 10)
      .slice(0, 10)

    if (ventes.length === 0) {
      return res.status(200).json({ 
        error: 'Données insuffisantes', 
        dvf: null,
        geo: { lat, lng, ville, codePostal }
      })
    }

    // Calculer prix moyen au m²
    const prixM2List = ventes.map(v => parseFloat(v.valeur_fonciere) / parseFloat(v.surface_reelle_bati))
    const avgM2 = Math.round(prixM2List.reduce((a, b) => a + b, 0) / prixM2List.length)
    const estValeur = surfNum ? Math.round(avgM2 * surfNum) : null

    // Samples pour affichage
    const samples = ventes.slice(0, 5).map(v => ({
      d: new Date(v.date_mutation).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }),
      s: Math.round(parseFloat(v.surface_reelle_bati)),
      p: Math.round(parseFloat(v.valeur_fonciere)),
      m: Math.round(parseFloat(v.valeur_fonciere) / parseFloat(v.surface_reelle_bati))
    }))

    return res.status(200).json({
      dvf: {
        avgM2,
        est: estValeur,
        comp: ventes.length,
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
