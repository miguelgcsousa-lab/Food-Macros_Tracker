export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { messages, system, user_id, is_photo } = req.body;

    // ── PLAN CHECK (only for photo analyses) ──────────────
    if (is_photo && user_id && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const today = new Date().toISOString().slice(0, 10);
      const headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      };

      // Get user settings
      const settingsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${user_id}&select=plan,daily_analyses,last_analysis_date,is_admin`,
        { headers }
      );
      const settings = await settingsRes.json();
      const userSettings = settings?.[0];

      if (userSettings) {
        const plan = userSettings.plan || 'free';
        const isAdmin = userSettings.is_admin === true;
        const lastDate = userSettings.last_analysis_date;
        const dailyCount = lastDate === today ? (userSettings.daily_analyses || 0) : 0;

        // Get limit from plan_config table
        let limit = 3; // fallback default
        if (!isAdmin) {
          const planRes = await fetch(
            `${SUPABASE_URL}/rest/v1/plan_config?plan=eq.${plan}&select=daily_photo_limit`,
            { headers }
          );
          const planData = await planRes.json();
          if (planData?.[0]?.daily_photo_limit !== undefined) {
            limit = planData[0].daily_photo_limit;
          }
        } else {
          limit = 999;
        }

        if (dailyCount >= limit) {
          return res.status(429).json({
            error: 'LIMIT_REACHED',
            message: `Atingiste o limite diário de ${limit} análise${limit !== 1 ? 's' : ''} por foto. Faz upgrade para Premium para análises ilimitadas.`,
            count: dailyCount,
            limit
          });
        }

        // Update counter
        await fetch(
          `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${user_id}`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ daily_analyses: dailyCount + 1, last_analysis_date: today })
          }
        );
      }
    }

    // ── ANTHROPIC API ──────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1000,
        system,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'API error',
        full: data
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
