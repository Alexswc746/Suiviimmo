export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { pdf_base64 } = req.body
  if (!pdf_base64) return res.status(400).json({ error: 'PDF manquant' })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
          },
          {
            type: 'text',
            text: `Analyse cet avis de valeur immobilier et extrait UNIQUEMENT ces données en JSON strict, sans markdown ni backticks :
{
  "prix": <prix estimé central en euros, nombre entier>,
  "fourchette_bas": <fourchette basse en euros, nombre entier>,
  "fourchette_haut": <fourchette haute en euros, nombre entier>,
  "date": "<date de l'avis au format YYYY-MM-DD>",
  "source": "<nom du logiciel : Perizia, Evaluat'immo, MyNotary, Immovalor ou Autre>"
}
Si une valeur est introuvable mets null. Réponds UNIQUEMENT avec le JSON.`
          }
        ]
      }]
    })
  })

  const data = await response.json()
  res.status(200).json(data)
}
