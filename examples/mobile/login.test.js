import { test, step, fill, expectCount } from '../../src/steps.js'

/**
 * Android example test.
 *
 * Selectors here are NOT CSS. natl resolves them in this order:
 *   - a string starting with `//`        -> XPath
 *   - a string starting with `xpath=`    -> XPath (prefix stripped)
 *   - a string starting with `id=`       -> Appium resource-id strategy
 *   - anything else                      -> accessibility id
 *
 * Run it with an Appium server listening on 127.0.0.1:4723 and a device or
 * emulator matching capabilities.json. See examples/mobile/README.md.
 */
export default test('android login flow', [
  step('type ada@example.com into the email field and tap Sign In'),
  fill('com.example:id/password', 'hunter2'),
  expectCount('//android.widget.Button[contains(@text,"Sign In")]', 1),
])