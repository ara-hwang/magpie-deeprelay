import assert from "node:assert/strict"
import test from "node:test"

import { DeepRelayPlugin, _internal } from "../index.mjs"

const savedBase = process.env.DEEPRELAY_API_BASE
delete process.env.DEEPRELAY_API_BASE
test.after(() => {
  if (savedBase === undefined) delete process.env.DEEPRELAY_API_BASE
  else process.env.DEEPRELAY_API_BASE = savedBase
})

function withFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url
    calls.push({ url, init })
    return handler(url, init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function configuredPlugin() {
  const plugin = await DeepRelayPlugin({}, undefined)
  const cfg = {}
  await plugin.config(cfg)
  return { plugin, provider: cfg.provider.deeprelay }
}

test("declares deeprelay as an OpenAI-compatible provider", async () => {
  const { provider } = await configuredPlugin()

  assert.equal(provider.name, "deeprelay")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.equal(provider.api, "https://api.deeprelay.ai/v1")
  assert.equal(provider.models["deepseek-v4.1-flash"].id, "deeprelay/deepseek-v4.1-flash")
  assert.equal(provider.models["deepseek-v4.1-flash"].limit.context, 1_000_000)
  assert.equal(provider.models["deepseek-v4.1-flash"].tool_call, true)
  assert.ok(provider.models["kimi-k3"])
  assert.ok(provider.models["qwen3.8-max"])
})

test("lists the account's chat models and keeps the seeded metadata", async (t) => {
  const { plugin, provider } = await configuredPlugin()
  const stub = withFetch((url, init) => {
    assert.equal(url, "https://api.deeprelay.ai/v1/models?modality=chat")
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer deeprelay_live_test")
    return json({
      object: "list",
      data: [
        { id: "deeprelay/deepseek-v4.1-flash", object: "model", owned_by: "DeepSeek" },
        { id: "deeprelay/brand-new", object: "model", owned_by: "Future" },
      ],
    })
  })
  t.after(() => stub.restore())

  const models = await plugin.provider.models(provider, { auth: { type: "api", key: "deeprelay_live_test" } })

  assert.deepEqual(Object.keys(models).sort(), ["brand-new", "deepseek-v4.1-flash"])
  assert.equal(models["deepseek-v4.1-flash"].name, "DeepSeek V4.1 Flash 1017")
  assert.equal(models["deepseek-v4.1-flash"].id, "deeprelay/deepseek-v4.1-flash")
  assert.equal(models["deepseek-v4.1-flash"].limit.context, 1_000_000)
  assert.equal(models["brand-new"].name, "Brand New")
  assert.equal(models["brand-new"].id, "deeprelay/brand-new")
  assert.equal(models["brand-new"].limit.context, 128_000)
})

test("falls back to the previous model list when deeprelay fails", async (t) => {
  const { plugin, provider } = await configuredPlugin()
  const stub = withFetch(() => json({ detail: "nope" }, 500))
  t.after(() => stub.restore())

  const models = await plugin.provider.models(provider, { auth: { type: "api", key: "deeprelay_live_test" } })
  assert.equal(models, provider.models)
})

test("maps subscription billing into quota windows", async (t) => {
  const { plugin } = await configuredPlugin()
  const stub = withFetch((url, init) => {
    assert.equal(url, "https://api.deeprelay.ai/v1/billing/subscription")
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer deeprelay_live_test")
    return json(SUBSCRIPTION)
  })
  t.after(() => stub.restore())

  const usage = await plugin.auth.usage(async () => ({ type: "api", key: "deeprelay_live_test" }))

  assert.equal(usage.plan, "Plus — $4.99 / month")
  assert.equal(usage.until, "2026-11-28T14:31:53.000Z")
  assert.equal(usage.renew, "auto")
  assert.equal(usage.balance, undefined)
  assert.equal(stub.calls.length, 1)

  const byName = Object.fromEntries(usage.windows.map((window) => [window.name, window]))
  assert.deepEqual(Object.keys(byName), [
    "Monthly input",
    "Monthly output",
    "Weekly input (rolling)",
    "Weekly output (rolling)",
    "Metered usage",
    "Web searches",
  ])

  assert.equal(byName["Monthly input"].amount, 812_400_000)
  assert.equal(byName["Monthly input"].limit, 2_500_000_000)
  assert.equal(byName["Monthly input"].unit, "tokens")
  assert.equal(byName["Monthly input"].display, "812.4M / 2.5B weighted tokens")
  assert.equal(byName["Monthly input"].resetsAt, "2026-11-28T14:31:53.000Z")
  assert.equal(byName["Monthly input"].span, 31 * 86400)

  assert.equal(byName["Monthly output"].amount, 4_100_000)
  assert.equal(byName["Monthly output"].limit, 250_000_000)

  assert.equal(byName["Weekly input (rolling)"].amount, 310_500_000)
  assert.equal(byName["Weekly input (rolling)"].limit, 625_000_000)
  assert.equal(byName["Weekly input (rolling)"].resetsAt, undefined)
  assert.equal(byName["Weekly input (rolling)"].span, 7 * 86400)

  assert.equal(byName["Metered usage"].amount, 12.34)
  assert.equal(byName["Metered usage"].limit, 500)
  assert.equal(byName["Metered usage"].display, "$12.34 / $500.00 list price")
  assert.equal(byName["Metered usage"].resetsAt, "2026-11-28T14:31:53.000Z")

  assert.equal(byName["Web searches"].amount, 7)
  assert.equal(byName["Web searches"].limit, 500)
  assert.equal(byName["Web searches"].display, "7 / 500 searches")
})

test("reads the wallet balance when calls are billed pay-as-you-go", async (t) => {
  const { plugin } = await configuredPlugin()
  const stub = withFetch((url) => {
    if (url.endsWith("/billing/subscription")) {
      return json({
        ...SUBSCRIPTION,
        usage: { ...SUBSCRIPTION.usage, recent_payg_calls_24h: 3 },
      })
    }
    if (url.endsWith("/billing/balance")) {
      return json({ balance_cents: 1240, balance_dollars: 12.4, auto_pay_enabled: false })
    }
    throw new Error(`unexpected URL: ${url}`)
  })
  t.after(() => stub.restore())

  const usage = await plugin.auth.usage(async () => ({ type: "api", key: "deeprelay_live_test" }))

  assert.equal(usage.balance, "$12.40")
  assert.equal(stub.calls.length, 2)
  const payg = usage.windows.find((window) => window.name === "Pay-as-you-go")
  assert.ok(payg)
  assert.equal(payg.display, "3 calls billed to the credit balance in the last 24h")
  assert.equal(payg.aside, true)
})

test("shows the credit balance when there is no subscription", async (t) => {
  const { plugin } = await configuredPlugin()
  const stub = withFetch((url) => {
    if (url.endsWith("/billing/subscription")) {
      return json({ subscribed: false, status: "none", quota: SUBSCRIPTION.quota, usage: null })
    }
    if (url.endsWith("/billing/balance")) {
      return json({ balance_cents: 4250, balance_dollars: 42.5 })
    }
    throw new Error(`unexpected URL: ${url}`)
  })
  t.after(() => stub.restore())

  const usage = await plugin.auth.usage(async () => ({ type: "api", key: "deeprelay_live_test" }))

  assert.equal(usage.plan, "Pay as you go")
  assert.equal(usage.balance, "$42.50")
  assert.equal(usage.error, undefined)
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0].name, "Subscription")
  assert.equal(usage.windows[0].aside, true)
})

test("asks for the billing:read scope when the key lacks it", async (t) => {
  const { plugin } = await configuredPlugin()
  const stub = withFetch(() =>
    json(
      {
        type: "https://deeprelay.ai/problems/insufficient_scope",
        title: "Insufficient scope",
        status: 403,
        detail: "This API key needs the billing:read scope.",
        code: "insufficient_scope",
      },
      403,
    ),
  )
  t.after(() => stub.restore())

  const usage = await plugin.auth.usage(async () => ({ type: "api", key: "deeprelay_live_test" }))
  assert.match(usage.error, /billing:read/)
  assert.equal(usage.signIn, undefined)
})

test("marks a refused key as needing a new sign-in", async (t) => {
  const { plugin } = await configuredPlugin()
  const stub = withFetch(() => json({ code: "invalid_api_key", detail: "The API key is invalid." }, 401))
  t.after(() => stub.restore())

  const usage = await plugin.auth.usage(async () => ({ type: "api", key: "deeprelay_live_test" }))
  assert.match(usage.error, /refused/)
  assert.equal(usage.signIn, "expired")
})

test("the loader signs every request with the account key", async (t) => {
  const { plugin } = await configuredPlugin()
  const loader = await plugin.auth.loader(async () => ({
    type: "api",
    key: "\uFEFF deeprelay_live_test\u200B\n",
  }))

  assert.equal(loader.baseURL, "https://api.deeprelay.ai/v1")
  assert.equal(loader.apiKey, "deeprelay_live_test")

  const stub = withFetch((url, init) => {
    assert.equal(url, "https://api.deeprelay.ai/v1/chat/completions")
    const headers = new Headers(init.headers)
    assert.equal(headers.get("authorization"), "Bearer deeprelay_live_test")
    assert.equal(headers.get("x-deeprelay-client"), "magpie-deeprelay/0.1.0")
    return json({ ok: true })
  })
  t.after(() => stub.restore())

  const response = await loader.fetch("https://api.deeprelay.ai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer someone-else", "content-type": "application/json" },
    body: "{}",
  })
  assert.equal(response.status, 200)
})

test("DEEPRELAY_API_BASE overrides the endpoint", async (t) => {
  process.env.DEEPRELAY_API_BASE = "http://127.0.0.1:3999/v1/"
  t.after(() => {
    delete process.env.DEEPRELAY_API_BASE
  })

  const { plugin, provider } = await configuredPlugin()
  assert.equal(provider.api, "http://127.0.0.1:3999/v1")

  const stub = withFetch((url) => {
    assert.equal(url, "http://127.0.0.1:3999/v1/models?modality=chat")
    return json({ data: [] })
  })
  t.after(() => stub.restore())

  await plugin.provider.models(provider, { auth: { type: "api", key: "deeprelay_live_test" } })
})

test("formats token counts for the quota display", () => {
  assert.equal(_internal.compact(2_500_000_000), "2.5B")
  assert.equal(_internal.compact(500_000_000), "500M")
  assert.equal(_internal.compact(12_500_000), "12.5M")
  assert.equal(_internal.compact(2_050_000), "2.1M")
  assert.equal(_internal.compact(7), "7")
  assert.equal(_internal.usd(12.4), "$12.40")
  assert.equal(_internal.usd(-1), "-$1.00")
})

const SUBSCRIPTION = {
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
    recent_payg_calls_24h: 0,
    searches: 7,
  },
}
