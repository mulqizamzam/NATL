// goto is handled by the runner from config (web.url in natl.config.json).
import { test, step, click, fill, expectText, expectCount } from '../../src/steps.js'

const exampleTest = test('login flow', [
  step('type ada@example.com in the email field and click Sign In'),
  expectText('#status', 'Welcome, ada@example.com'),
  expectCount('#items .item', 2),
])

export default exampleTest
export { exampleTest }