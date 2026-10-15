/**
 * natl — Prompt builders
 *
 * Builds the system prompt and the per-step user message passed to the LLM.
 */

const TOOL_DEF =
  'Each action is an object with fields: action (string, one of click/fill/clear/press/scroll/wait), ref (string, matching an element index), and optionally value (string). Return only the JSON object — no markdown fences, no explanation.'

const SYSTEM_PROMPT = `You are a browser-testing agent. Given an instruction and a page snapshot, plan the exact sequence of actions to accomplish it.

Call the natl_plan tool with the plan. If you answer with text instead, reply
with only a JSON object with one field: "actions", an array of action objects.
${TOOL_DEF}

Always include the ref of each target element. Use the correct action type for the intent.
`

/**
 * Build the system prompt.
 * @returns {string}
 */
export function buildSystemPrompt() {
  return SYSTEM_PROMPT
}

/**
 * Build the user message for one planning step.
 *
 * @param {string} instruction — the plain-English instruction
 * @param {{elements: Array<{ref:string,role:string,name:string}>, text:string}} snapshot — current page snapshot
 * @param {string} driverName — human-readable name of the driver/platform
 * @returns {string}
 */
export function buildUserMessage(instruction, snapshot, driverName) {
  const lines = [`Instruction: ${instruction}`, `Driver: ${driverName}`, '']

  if (snapshot.elements && snapshot.elements.length > 0) {
    lines.push('Page elements:')
    for (const el of snapshot.elements) {
      lines.push(`  [${el.ref}] ${el.role}: "${el.name}"`)
    }
    lines.push('')
  }

  if (snapshot.text) {
    lines.push('Page text:')
    lines.push(snapshot.text)
    lines.push('')
  }

  return lines.join('\n')
}

export default { buildSystemPrompt, buildUserMessage }
