/**
 * natl — Planner: instruction + snapshot → action list
 *
 * Calls callModel once; if the response is not a valid plan, retries once with
 * a repair instruction appended to the system prompt. Validates all refs
 * against the snapshot before returning.
 */

import { callModel } from './llm.js'
import { buildSystemPrompt, buildUserMessage } from './prompt.js'
import { NatlError } from './llm.js'

const VALID_ACTIONS = new Set(['click', 'fill', 'clear', 'press', 'scroll', 'wait'])
const REPAIR_SUFFIX =
  '\n\nYour previous response was not a valid plan. Reply with ONLY a JSON object of the shape ' +
  '{"actions":[{"action":"...","ref":"...","value":"..."}]}. Use only the refs listed above. ' +
  'No prose, no markdown fences.'

/**
 * Is `parsed` a usable plan — a plain object carrying a NON-EMPTY `actions`
 * array? Anything else means the model did not comply and the step needs a
 * repair retry.
 *
 * The non-empty check is load-bearing: `{"actions":[]}` satisfies
 * `Array.isArray`, and an empty plan executes zero actions, which the runner
 * would report as a pass and then cache permanently — a green step that tests
 * nothing, replayed forever. The tool schema already declares minItems:1
 * (llm.js); that is a hint to the model, not an enforcement, so enforce it here
 * where the repair retry can still catch it.
 */
function isValidPlanShape(parsed) {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.actions) &&
    parsed.actions.length > 0
  )
}

/**
 * Execute one planning attempt (not public).
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} providerConfig
 * @param {Function} callModelFn
 */
async function attemptPlan({ systemPrompt, userMessage, providerConfig, callModelFn }) {
  const { parsed } = await callModelFn({
    provider: providerConfig.provider,
    model: providerConfig.model,
    apiKey: providerConfig.apiKey,
    baseUrl: providerConfig.baseUrl,
    system: systemPrompt,
    user: userMessage,
  })
  return parsed
}

/**
 * Validate every action in the plan against the snapshot.
 *
 * @param {Array} actions
 * @param {{elements: Array<{ref:string}>}} snapshot
 */
function validateActions(actions, snapshot) {
  const validRefs = new Set(snapshot.elements.map((e) => e.ref))
  for (const act of actions) {
    if (!VALID_ACTIONS.has(act.action)) {
      throw new NatlError(`invalid action "${act.action}" in plan`)
    }
    if (!validRefs.has(act.ref)) {
      throw new NatlError('invalid ref in plan')
    }
  }
}

/**
 * Plan one natural-language step.
 *
 * `drivers` (frozen contract 6) and `driverName` are both accepted: the first
 * may be a driver name or a driver object, the second is always the name.
 * It only labels the prompt — the planner never touches the driver.
 *
 * @param {object} params
 * @param {{provider:string, model:string, apiKey:string, baseUrl?:string}} params.provider
 * @param {string} params.instruction
 * @param {{elements: Array<{ref:string,role:string,name:string}>, text:string}} params.snapshot
 * @param {string|{name?:string}} [params.drivers]
 * @param {string} [params.driverName]
 * @param {Function} [params.callModelOverride] — inject a stub for testing
 * @returns {Promise<{actions: Array, provider: string, model: string}>}
 */
export async function plan({
  provider,
  instruction,
  snapshot,
  drivers,
  driverName,
  callModelOverride,
}) {
  const callModelFn = callModelOverride ?? callModel
  const resolvedDriverName =
    driverName ??
    (typeof drivers === 'string' ? drivers : drivers?.name) ??
    'web'
  const systemBase = buildSystemPrompt()
  const userMessage = buildUserMessage(instruction, snapshot, resolvedDriverName)

  let systemPrompt = systemBase
  let parsed
  let attempt = 0

  while (attempt < 2) {
    parsed = await attemptPlan({ systemPrompt, userMessage, providerConfig: provider, callModelFn })
    if (isValidPlanShape(parsed)) break

    // first failure — retry with a repair prompt appended to the system prompt
    if (attempt === 0) {
      systemPrompt = systemBase + REPAIR_SUFFIX
      attempt++
      continue
    }

    // second failure — give up
    throw new NatlError('planner failed after 2 attempts')
  }

  validateActions(parsed.actions, snapshot)

  return { actions: parsed.actions, provider: provider.provider, model: provider.model }
}

export default { plan }
