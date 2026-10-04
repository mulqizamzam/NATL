// natl — report rendering and JSON serialization.

/**
 * Render a report as a human-readable terminal string.
 * Never leaks API keys or provider secrets.
 */
export function renderReport(report) {
  const lines = [`natl ${report.name}:`]
  for (const step of report.steps) {
    const marker =
      step.status === 'pass' ? '✔' : step.status === 'fail' ? '✗' : '⊘'
    lines.push(`  ${marker} ${step.kind}${step.ms ? ` (${step.ms}ms)` : ''}`)
    if (step.detail) lines.push(`    ${step.detail}`)
  }
  const parts = [`modelCalls=${report.modelCalls}`]
  if (report.replayed > 0) parts.push(`replayed=${report.replayed}`)
  if (report.recorded > 0) parts.push(`recorded=${report.recorded}`)
  if (report.cacheError) parts.push(`cacheError=${report.cacheError}`)
  const summary = parts.join(', ')
  if (report.ok) {
    lines.push(`PASS ${report.name} — ${summary}`)
  } else {
    lines.push(`FAIL ${report.name} — ${summary} — ${report.error}`)
  }
  return lines.join('\n')
}

/**
 * Serialize a report to stable JSON. Omit `error` only when the report
 * succeeded and the message is empty — callers may diff the output.
 */
export function toJson(report) {
  return JSON.stringify(report, null, 2)
}

/**
 * Summarize a list of reports across one or more test files.
 */
export function summarize(reports) {
  const total = reports.length
  const passed = reports.filter((r) => r.ok).length
  const failed = total - passed
  let modelCalls = 0
  let replayed = 0
  for (const r of reports) {
    modelCalls += r.modelCalls
    replayed += r.replayed
  }
  return { total, passed, failed, modelCalls, replayed }
}

export default { renderReport, toJson, summarize }