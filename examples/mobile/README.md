# Mobile Example — natl

This example drives a real mobile app through Appium. Unlike the web example, it
**cannot be executed on the machine that produced this repository** — see
[Why this is not runnable here](#why-this-is-not-runnable-here).

## Files

- `login.test.js` — the test itself. One plain-English step plus deterministic assertions.
- `capabilities.json` — W3C capabilities for the Appium session. Copy and edit it.

## The test

```js
import { test, step, fill, expectText, expectCount } from '../../src/steps.js'

export default test('android login flow', [
  step('type ada@example.com in the email field and tap Sign In'),
  expectText('Email is required', 'Email is required'), // sanity: app is loaded
  fill('com.example:id/password', 'hunter2'),
  expectCount('//android.widget.Button[contains(@text,"Sign In")]', 1),
])
```

Note the selector style: mobile selectors are **accessibility ids** (`resource-id`
on Android, `name` on iOS) by default, or **XPath** when the string starts with `//`.
A CSS selector will not work here, and the runner will tell you so.

## Setup

### 1. Install Appium and the driver

```bash
npm i -g appium
appium driver install uiautomator2   # Android
appium driver install xcuitest      # iOS, macOS only
```

Appium 3 requires Node `^20.19.0 || ^22.12.0 || >=24.0.0`. The default port is
`4723` and the default base path is empty — **not** `/wd/hub`.

### 2. Provide an app and a device

Edit `capabilities.json`:

```json
{
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:app": "/absolute/path/to/app-debug.apk",
  "appium:deviceName": "Pixel_7_API_34",
  "appium:udid": "emulator-5554",
  "appium:platformVersion": "14"
}
```

You need one of:

- an Android emulator (requires the Android SDK, `adb`, and KVM at `/dev/kvm` for
  usable speed), or
- a physical device over `adb connect <ip>:<port>`, or
- a device cloud. Point `server` in `natl.config.json` at the cloud's URL — the
  W3C capabilities are identical, so nothing else changes.

### 3. Start the server and run

```bash
appium server --port 4723     # terminal 1
natl run examples/mobile/login.test.js --config examples/mobile/natl.config.json
```

## iOS

Change `platformName` to `iOS` and `appium:automationName` to `XCUITest`.

**XCUITest requires macOS with Xcode.** It cannot run from Linux or Windows. On
Linux you must use a device cloud or a remote macOS host — there is no workaround.

## Why this is not runnable here

This repository was built on a headless Linux host with no Java, no `adb`, no
Appium server, and no `/dev/kvm`. The mobile driver is therefore covered by tests
against a fake WebDriver server (`test/drivers/mobile.test.js` +
`test/helpers/fake-webdriver.js`) that implements the same W3C endpoints over a
fixed Android page-source XML. Those tests prove the request shapes, the XML
element mapping, the action dispatch, and the error paths. They do **not** prove
that a real APK launches and responds, because that could not be measured here.

Do not treat this example as verified against a real device.