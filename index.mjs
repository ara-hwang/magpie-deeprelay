// magpie / OpenCode provider plugin for deeprelay.ai
//
// deeprelay serves DeepSeek, GLM, Kimi, Qwen and more behind one
// OpenAI-compatible endpoint. This plugin signs in with an API key, lists the
// chat models the key can use, and reads the plan's usage meters from the
// documented billing API (scope: billing:read).

const PROVIDER = "deeprelay"
const VERSION = "0.1.0"
const DEFAULT_BASE = "https://api.deeprelay.ai/v1"
const CLIENT = `opencode-deeprelay-auth/${VERSION}`

// The chat catalogue deeprelay publishes. The live /v1/models call is still the
// source of truth; these entries provide names, context limits and capability
// flags when the account's list is fetched. Keep keys without the
// "deeprelay/" prefix: magpie writes the provider id before them.
const SEED_MODELS = {
  "deepseek-v4-pro": model("DeepSeek V4 Pro 0813", "deepseek-v4-pro", 1_000_000, { reasoning: true }),
  "deepseek-v4.1-flash": model("DeepSeek V4.1 Flash 1017", "deepseek-v4.1-flash", 1_000_000, { reasoning: true }),
  "glm-5.2": model("GLM 5.2", "glm-5.2", 1_000_000, { reasoning: true }),
  "glm-5.3": model("GLM 5.3", "glm-5.3", 1_000_000, { reasoning: true }),
  "glm-5.3-flash": model("GLM 5.3 Flash", "glm-5.3-flash", 1_000_000, { reasoning: true }),
  "gpt-oss-120b": model("GPT-OSS 120B", "gpt-oss-120b", 131_072, { reasoning: true }),
  "kimi-k3": model("Kimi K3", "kimi-k3", 1_000_000, { reasoning: true }),
  "kimi-k3.1-pro": model("Kimi K3.1 Pro", "kimi-k3.1-pro", 1_000_000, { reasoning: true }),
  "minimax-m3.1-flash": model("MiniMax M3.1 Flash", "minimax-m3.1-flash", 1_000_000),
  "muse-glimmer-30b": model("Muse Glimmer 30B", "muse-glimmer-30b", 131_072),
  "muse-spark-open-816b-a42b": model("Muse Spark Open 816B A42B", "muse-spark-open-816b-a42b", 1_000_000),
  "qwen3.5-9b": model("Qwen3.5 9B", "qwen3.5-9b", 262_144),
  "qwen3.6-plus": model("Qwen3.6 Plus", "qwen3.6-plus", 1_000_000, { reasoning: true }),
  "qwen3.7-max": model("Qwen3.7 Max", "qwen3.7-max", 1_000_000, { reasoning: true }),
  "qwen3.7-plus": model("Qwen3.7 Plus", "qwen3.7-plus", 1_000_000, { reasoning: true }),
  "qwen3.8-flash": model("Qwen3.8 Flash", "qwen3.8-flash", 1_000_000, { reasoning: true }),
  "qwen3.8-max": model("Qwen3.8 Max", "qwen3.8-max", 1_000_000, { reasoning: true }),
}

let configuredBase = ""

export const DeepRelayPlugin = async (_input, options) => {
  configuredBase = normalizeBase(options?.baseURL)

  return {
    // The provider is not on models.dev, so declare it here. ??= keeps a
    // provider the user configured in plugins.json untouched.
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "deeprelay",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL(),
        models: seedModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "deeprelay API key",
          placeholder: "deeprelay_live_…",
        },
      ],

      // Every request this account makes goes through here, with the key.
      async loader(getAuth) {
        const auth = await getAuth()
        const key = apiKey(auth)
        if (!key) return {}
        return {
          baseURL: baseURL(),
          // magpie hands an API-key sign-in to the AI SDK as apiKey by
          // default. Give it the cleaned key so a pasted BOM never reaches a
          // header before our fetch() can replace it.
          apiKey: key,
          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            headers.set("authorization", `Bearer ${key}`)
            headers.set("x-deeprelay-client", CLIENT)
            return fetch(input, { ...init, headers })
          },
        }
      },

      // magpie's own hook: show the plan's meters on the account, in
      // `magpie quota` and at /v1/magpie/quotas.
      async usage(getAuth) {
        const auth = await getAuth()
        const key = apiKey(auth)
        if (!key) return { error: "Sign in with a deeprelay API key to read usage." }

        let res
        try {
          res = await api("/billing/subscription", key)
        } catch (err) {
          return { error: `Could not reach deeprelay: ${errorText(err)}` }
        }
        if (!res.ok) return usageError(res, await problem(res))

        let sub
        try {
          sub = await res.json()
        } catch {
          return { error: "deeprelay sent an unreadable billing response." }
        }

        const entitled = sub?.subscribed === true
        const result = {
          plan: planLabel(sub, entitled),
          windows: [],
        }
        const periodEnd = isoTime(sub?.current_period_end)
        if (periodEnd) result.until = periodEnd
        if (entitled) result.renew = sub?.cancel_at_period_end === true ? "off" : "auto"

        if (!entitled) {
          const balance = await readBalance(key)
          if (balance) result.balance = balance
          result.windows.push({
            name: "Subscription",
            display: "No active deeprelay subscription — usage bills to the credit balance",
            aside: true,
          })
          if (!balance) result.error = "No active deeprelay subscription; the credit balance could not be read."
          return result
        }

        const usage = sub?.usage
        if (!usage || typeof usage !== "object") {
          result.error = "deeprelay did not return the subscription usage meter."
          return result
        }

        const quota = sub?.quota ?? {}
        const span = spanSeconds(sub?.current_period_start, sub?.current_period_end)
        const windows = []

        addTokenWindow(windows, "Monthly input", usage.weighted_input_tokens, quota.input_tokens_monthly, {
          resetsAt: periodEnd,
          span,
        })
        addTokenWindow(windows, "Monthly output", usage.weighted_output_tokens, quota.output_tokens_monthly, {
          resetsAt: periodEnd,
          span,
        })
        addTokenWindow(windows, "Weekly input (rolling)", usage.weekly_weighted_input_tokens, quota.weekly_input_tokens, {
          span: 7 * 86400,
        })
        addTokenWindow(windows, "Weekly output (rolling)", usage.weekly_weighted_output_tokens, quota.weekly_output_tokens, {
          span: 7 * 86400,
        })

        const cost = number(usage.cost_micro_cents)
        const ceiling = number(quota.max_usage_micro_cents)
        if (cost != null && ceiling != null && ceiling > 0) {
          const usedDollars = cost / 1e8
          const ceilingDollars = ceiling / 1e8
          windows.push({
            name: "Metered usage",
            amount: round2(usedDollars),
            limit: round2(ceilingDollars),
            unit: "USD",
            display: `${usd(usedDollars)} / ${usd(ceilingDollars)} list price`,
            ...(periodEnd ? { resetsAt: periodEnd } : {}),
            ...(span ? { span } : {}),
          })
        }

        const searches = number(usage.searches)
        const searchLimit = number(quota.searches_monthly)
        if (searches != null && searchLimit != null && searchLimit > 0) {
          windows.push({
            name: "Web searches",
            amount: searches,
            limit: searchLimit,
            unit: "searches",
            display: `${searches} / ${searchLimit} searches`,
            ...(periodEnd ? { resetsAt: periodEnd } : {}),
            ...(span ? { span } : {}),
          })
        }

        const paygCalls = number(usage.recent_payg_calls_24h)
        if (paygCalls != null && paygCalls > 0) {
          const balance = await readBalance(key)
          if (balance) result.balance = balance
          windows.push({
            name: "Pay-as-you-go",
            display: `${paygCalls} call${paygCalls === 1 ? "" : "s"} billed to the credit balance in the last 24h`,
            aside: true,
          })
        }

        result.windows = windows
        return result
      },
    },

    // The models this account has, asked of deeprelay. On any failure magpie
    // keeps the list it already had.
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const known = provider?.models ?? {}
        const key = apiKey(auth)
        if (!key) return known

        let res
        try {
          res = await api("/models?modality=chat", key)
        } catch {
          return known
        }
        if (!res.ok) return known

        let body
        try {
          body = await res.json()
        } catch {
          return known
        }

        const list = Array.isArray(body?.data) ? body.data : []
        if (!list.length) return known

        const models = {}
        for (const item of list) {
          const id = String(item?.id ?? "").trim()
          if (!id) continue
          const short = id.startsWith(`${PROVIDER}/`) ? id.slice(PROVIDER.length + 1) : id
          if (!short) continue
          const seed = known[short] ?? SEED_MODELS[short]
          models[short] = seed
            ? { ...seed, id, limit: { ...seed.limit } }
            : unknownModel(id, short)
        }
        return models
      },
    },
  }
}

function model(name, key, context, extra = {}) {
  return {
    name,
    id: `${PROVIDER}/${key}`,
    limit: { context, output: context >= 1_000_000 ? 65_536 : 32_768 },
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    ...extra,
  }
}

function seedModels() {
  return Object.fromEntries(
    Object.entries(SEED_MODELS).map(([key, value]) => [key, { ...value, limit: { ...value.limit } }]),
  )
}

function unknownModel(id, key) {
  return {
    ...model(prettyName(key), key, 128_000),
    id,
  }
}

const ACRONYMS = new Set(["api", "glm", "gpt", "llm", "mcp", "mt", "oss", "vl"])

function prettyName(key) {
  return key
    .replace(/^.*\//, "")
    .split("-")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      if (ACRONYMS.has(lower)) return lower.toUpperCase()
      if (/^\d+[a-z]$/i.test(part)) return part.slice(0, -1) + part.slice(-1).toUpperCase()
      return part[0].toUpperCase() + part.slice(1)
    })
    .join(" ")
}

function baseURL() {
  return configuredBase || normalizeBase(process.env.DEEPRELAY_API_BASE) || DEFAULT_BASE
}

function normalizeBase(value) {
  const text = String(value ?? "").trim()
  return text ? text.replace(/\/+$/, "") : ""
}

function apiKey(auth) {
  if (auth?.type !== "api") return ""
  // Pasted keys occasionally carry a BOM or a zero-width space, and a piped
  // sign-in can keep the newline. None of them belong in an HTTP header.
  return String(auth.key ?? "")
    .replace(/[\uFEFF\u200B]/g, "")
    .trim()
}

function timeoutSignal(ms) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined
}

function api(path, key, init = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${key}`)
  headers.set("accept", "application/json")
  headers.set("x-deeprelay-client", CLIENT)
  return fetch(`${baseURL()}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? timeoutSignal(15_000),
  })
}

async function readBalance(key) {
  try {
    const res = await api("/billing/balance", key)
    if (!res.ok) return null
    const body = await res.json()
    const dollars = number(body?.balance_dollars)
    if (dollars != null) return usd(dollars)
    const cents = number(body?.balance_cents)
    if (cents != null) return usd(cents / 100)
  } catch {
    // The balance is a secondary read: a plan's meters still show without it.
  }
  return null
}

async function usageError(res, info) {
  if (res.status === 401) {
    return { error: "deeprelay refused this API key. Sign in again.", signIn: "expired" }
  }
  if (res.status === 403 && (info.code === "insufficient_scope" || /billing:read|scope/i.test(info.detail))) {
    return { error: "This deeprelay key needs the billing:read scope to show usage." }
  }
  const suffix = info.detail ? `: ${info.detail}` : ""
  return { error: `deeprelay answered ${res.status}${suffix}` }
}

async function problem(res) {
  try {
    const body = await res.json()
    return {
      code: String(body?.code ?? ""),
      detail: String(body?.detail ?? body?.title ?? body?.message ?? ""),
    }
  } catch {
    return { code: "", detail: "" }
  }
}

function addTokenWindow(windows, name, usedValue, limitValue, extra) {
  const used = number(usedValue)
  const limit = number(limitValue)
  if (used == null || limit == null || limit <= 0) return
  windows.push({
    name,
    amount: used,
    limit,
    unit: "tokens",
    display: `${compact(used)} / ${compact(limit)} weighted tokens`,
    ...(extra.resetsAt ? { resetsAt: extra.resetsAt } : {}),
    ...(extra.span ? { span: extra.span } : {}),
  })
}

function planLabel(sub, entitled) {
  if (!entitled) return "Pay as you go"
  const plan = sub?.plan
  if (!plan?.name) return "deeprelay"
  const cents = number(plan.price?.amount_cents)
  const interval = String(plan.price?.interval ?? "").trim()
  if (cents == null || !interval) return plan.name
  const count = number(plan.price?.interval_count) ?? 1
  const every = count > 1 ? `${count} ${interval}s` : interval
  return `${plan.name} — ${usd(cents / 100)} / ${every}`
}

function number(value) {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function usd(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return ""
  const sign = amount < 0 ? "-" : ""
  return `${sign}$${Math.abs(amount).toFixed(2)}`
}

function compact(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return "0"
  const abs = Math.abs(amount)
  for (const [size, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]) {
    if (abs >= size) return `${oneDecimal(amount / size)}${suffix}`
  }
  return String(amount)
}

function oneDecimal(value) {
  return String(Math.round(value * 10) / 10)
}

function spanSeconds(start, end) {
  const from = Date.parse(start)
  const to = Date.parse(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return Math.round((to - from) / 1000)
}

function isoTime(value) {
  if (value == null || value === "") return null
  const parsed =
    typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value))
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function errorText(error) {
  return error?.message ?? String(error)
}

// Exported for tests without exporting extra plugin functions: magpie calls
// every function a plugin module exports.
export const _internal = {
  api,
  compact,
  planLabel,
  prettyName,
  usd,
  SEED_MODELS,
}
