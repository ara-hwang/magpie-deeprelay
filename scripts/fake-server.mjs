// A small stand-in for deeprelay's API, used for end-to-end checks.
// Run: node test/fake-server.mjs
import http from "node:http"

const port = Number(process.env.PORT ?? 3999)
const host = "127.0.0.1"

const subscription = {
  subscribed: true,
  status: "active",
  cancel_at_period_end: false,
  current_period_start: "2026-10-28T14:31:53Z",
  current_period_end: "2026-11-28T14:31:53Z",
  plan: {
    key: "plus",
    name: "Plus",
    price: { amount_cents: 499, currency: "usd", interval: "month", interval_count: 1 },
  },
  quota: {
    input_tokens_monthly: 2_500_000_000,
    output_tokens_monthly: 250_000_000,
    weekly_input_tokens: 625_000_000,
    weekly_output_tokens: 62_500_000,
    max_usage_micro_cents: 50_000_000_000,
    payg_discount_bp: 0,
    searches_monthly: 500,
  },
  usage: {
    period_start: "2026-10-28T14:31:53Z",
    period_end: "2026-11-28T14:31:53Z",
    weighted_input_tokens: 812_400_000,
    weighted_output_tokens: 4_100_000,
    weekly_weighted_input_tokens: 310_500_000,
    weekly_weighted_output_tokens: 2_050_000,
    cost_micro_cents: 1_234_000_000,
    recent_payg_calls_24h: 3,
    searches: 7,
  },
}

const models = {
  object: "list",
  data: [
    { id: "deeprelay/deepseek-v4.1-flash", object: "model", owned_by: "DeepSeek" },
    { id: "deeprelay/glm-5.3", object: "model", owned_by: "Z.ai" },
    { id: "deeprelay/kimi-k3", object: "model", owned_by: "Moonshot AI" },
  ],
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type })
    res.end(JSON.stringify(body))
  }

  const auth = req.headers.authorization ?? ""
  if (!auth.startsWith("Bearer deeprelay_live_")) {
    return send(401, { code: "invalid_api_key", detail: "The API key is invalid." })
  }

  if (url.pathname === "/v1/models") {
    return send(200, models)
  }
  if (url.pathname === "/v1/billing/subscription") {
    return send(200, subscription)
  }
  if (url.pathname === "/v1/billing/balance") {
    return send(200, { balance_cents: 1240, balance_dollars: 12.4, auto_pay_enabled: false })
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {}
      send(200, {
        id: "chatcmpl-fake",
        object: "chat.completion",
        model: parsed.model ?? "deeprelay/deepseek-v4.1-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "pong" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
    return
  }
  send(404, { code: "not_found", detail: `${req.method} ${url.pathname} is not part of the fake API` })
})

server.listen(port, host, () => {
  console.log(`fake deeprelay API on http://${host}:${port}/v1`)
})
