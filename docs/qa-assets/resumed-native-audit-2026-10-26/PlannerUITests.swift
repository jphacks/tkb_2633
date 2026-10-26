import XCTest
import XCUIAutomation

@MainActor final class PlannerUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    func settingsApp() throws -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
        app.launch()
        XCTAssertTrue(app.buttons["設定を開く"].waitForExistence(timeout: 60), "Planner home did not load")
        app.buttons["設定を開く"].tap()
        let google = app.buttons["Google Tasks同期を開く"]
        XCTAssertTrue(google.waitForExistence(timeout: 15))
        google.tap()
        XCTAssertTrue(app.staticTexts["接続済み"].waitForExistence(timeout: 30), "Saved Google session was not restored")
        return app
    }
    func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<6 {
            if element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "Required control is not visible")
    }
    func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
    func testColdLaunchRestoresGoogleSession() throws {
        let app = try settingsApp()
        attach(app, "ios-restored-google-session")
    }
    func testCalendarOff() throws {
        let app = try settingsApp()
        let control = app.switches["Googleカレンダーの予定を家事日調整に使う"]
        reveal(control, in: app)
        XCTAssertEqual(control.value as? String, "1")
        control.tap()
        XCTAssertTrue(app.staticTexts["カレンダーによる家事日調整を停止しました。"].waitForExistence(timeout: 120))
        XCTAssertEqual(control.value as? String, "0")
        attach(app, "ios-calendar-off")
    }
    func testCalendarOn() throws {
        let app = try settingsApp()
        let control = app.switches["Googleカレンダーの予定を家事日調整に使う"]
        reveal(control, in: app)
        XCTAssertEqual(control.value as? String, "0")
        control.tap()
        XCTAssertTrue(app.staticTexts["カレンダー連携を有効にしました。取得状態を確認してください。"].waitForExistence(timeout: 120))
        XCTAssertEqual(control.value as? String, "1")
        attach(app, "ios-calendar-on")
    }
    func calendarApp() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
        app.launch()
        XCTAssertTrue(app.buttons["設定を開く"].waitForExistence(timeout: 60))
        let calendar = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "カレンダー")).firstMatch
        XCTAssertTrue(calendar.waitForExistence(timeout: 10))
        calendar.tap()
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.dateFormat = "M月d日"
        let selectedDate = Calendar.current.date(byAdding: .day, value: 3, to: Date())!
        let prefix = formatter.string(from: selectedDate) + "、"
        let day = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        XCTAssertTrue(day.waitForExistence(timeout: 15), "Selected test date is not available in the calendar")
        day.tap()
        return app
    }
    func testCompleteSelectedOccurrence() throws {
        let app = calendarApp()
        let control = app.descendants(matching: .any).matching(identifier: "食器を洗うを完了").firstMatch
        XCTAssertTrue(control.waitForExistence(timeout: 15), "Expected an incomplete test occurrence")
        reveal(control, in: app)
        control.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "食器を洗うを未完了に戻す").firstMatch.waitForExistence(timeout: 15))
        attach(app, "ios-selected-date-completed")
    }
    func testUndoSelectedOccurrence() throws {
        let app = calendarApp()
        let control = app.descendants(matching: .any).matching(identifier: "食器を洗うを未完了に戻す").firstMatch
        XCTAssertTrue(control.waitForExistence(timeout: 15), "Expected the completed test occurrence")
        reveal(control, in: app)
        control.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "食器を洗うを完了").firstMatch.waitForExistence(timeout: 15))
        attach(app, "ios-selected-date-undone")
    }
    func testDisabledChoreCycleAutosavesAcrossBackground() throws {
        let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
        app.activate()
        let opener = app.alerts.buttons["開く"]
        if opener.waitForExistence(timeout: 3) { opener.tap() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let systemOpener = springboard.alerts.buttons["開く"]
        if systemOpener.exists { systemOpener.tap() }
        let enabled = app.switches["家事を有効にする"]
        XCTAssertTrue(enabled.waitForExistence(timeout: 30))
        XCTAssertEqual(enabled.value as? String, "0", "Keep the original disabled chore disabled")
        let cycle = app.textFields["家事周期の日数"]
        XCTAssertTrue(cycle.waitForExistence(timeout: 10))
        let initialValue = cycle.value as? String ?? ""
        XCTAssertTrue(initialValue.allSatisfy(\.isNumber))
        cycle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        cycle.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: initialValue.count) + "17")
        XCTAssertEqual(cycle.value as? String, "17")
        XCTAssertTrue(app.staticTexts["保存しました"].waitForExistence(timeout: 30))
        attach(app, "ios-cycle-17-autosaved")
        cycle.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
        XCTAssertEqual(cycle.value as? String, "")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 15))
        app.activate()
        XCTAssertTrue(cycle.waitForExistence(timeout: 30))
        let restored = NSPredicate(format: "value == %@", "7")
        expectation(for: restored, evaluatedWith: cycle)
        waitForExpectations(timeout: 30)
        XCTAssertEqual(enabled.value as? String, "0")
        attach(app, "ios-empty-cycle-restored-after-background")
    }
    func testQAWidgetCompletesWithAppStopped() throws {
        let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
        app.terminate()
        let home = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(home.wait(for: .runningForeground, timeout: 15))
        let complete = home.buttons.matching(NSPredicate(format: "label CONTAINS %@", "フローリング")).firstMatch
        XCTAssertTrue(complete.waitForExistence(timeout: 15))
        complete.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        let undo = app.descendants(matching: .any).matching(identifier: "フローリングを掃除するを未完了に戻す").firstMatch
        XCTAssertTrue(undo.waitForExistence(timeout: 60))
        attach(app, "ios-widget-completion-imported")
        Thread.sleep(forTimeInterval: 5)
    }
    func testQAWidgetUndoDoesNotReplayAfterResume() throws {
        let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
        app.activate()
        let undo = app.descendants(matching: .any).matching(identifier: "フローリングを掃除するを未完了に戻す").firstMatch
        XCTAssertTrue(undo.waitForExistence(timeout: 30))
        reveal(undo, in: app)
        undo.tap()
        let complete = app.descendants(matching: .any).matching(identifier: "フローリングを掃除するを完了").firstMatch
        XCTAssertTrue(complete.waitForExistence(timeout: 30))
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 15))
        app.activate()
        Thread.sleep(forTimeInterval: 3)
        XCTAssertTrue(complete.waitForExistence(timeout: 30))
        XCTAssertFalse(undo.exists)
        attach(app, "ios-widget-undo-stable-after-resume")
    }
}
