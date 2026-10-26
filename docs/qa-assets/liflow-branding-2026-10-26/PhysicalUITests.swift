import XCTest
import XCUIAutomation

// Recorded physical-device scenarios. Run individually with the documented fixture; not CI.
@MainActor final class PhysicalUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    func attach(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-accessibility"
        tree.lifetime = .keepAlways
        add(tree)
    }

    func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) {
        for _ in 0..<14 {
            if element.exists && element.isHittable { return }
            if towardTop { app.swipeDown() } else { app.swipeUp() }
        }
        XCTAssertTrue(element.exists && element.isHittable, "Expected control must be visible")
    }

    func testReleasePersistenceCompletionAndUndo() throws {
        let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
        app.launch()
        XCTAssertTrue(app.buttons["設定を開く"].waitForExistence(timeout: 30))
        let complete = app.descendants(matching: .any).matching(identifier: "トイレを掃除するを完了").firstMatch
        reveal(complete, in: app)
        complete.tap()
        let undo = app.descendants(matching: .any).matching(identifier: "トイレを掃除するを未完了に戻す").firstMatch
        XCTAssertTrue(undo.waitForExistence(timeout: 15))
        reveal(undo, in: app)
        undo.tap()
        XCTAssertTrue(complete.waitForExistence(timeout: 15))
        attach(app, "physical-release-complete-and-undo")
        app.buttons["設定を開く"].tap()
        let settings = app.buttons["家事ごとの設定を開く"]
        reveal(settings, in: app)
        settings.tap()
        let group = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "水回り")).firstMatch
        reveal(group, in: app)
        group.tap()
        let chore = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "トイレを掃除する")).firstMatch
        reveal(chore, in: app)
        chore.tap()
        let enabled = app.switches["家事を有効にする"]
        XCTAssertTrue(enabled.waitForExistence(timeout: 15))
        XCTAssertEqual(enabled.value as? String, "1")
        let cycle = app.textFields["家事周期の日数"]
        XCTAssertEqual(cycle.value as? String, "17")
        attach(app, "physical-release-autosaved-settings-preserved")
        cycle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        cycle.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2) + "7")
        enabled.tap()
        app.buttons["前の画面に戻る"].tap()
        app.buttons["前の画面に戻る"].tap()
        XCTAssertTrue(app.buttons["設定を開く"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "トイレを掃除するを完了").firstMatch.exists)
        attach(app, "physical-release-settings-restored")
    }

    func testLiFlowLauncherNameAndIcon() throws {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let icon = springboard.icons["LiFlow"].firstMatch
        for _ in 0..<3 {
            if icon.exists && icon.isHittable { break }
            springboard.swipeLeft()
            _ = springboard.icons.firstMatch.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(icon.exists && icon.isHittable)
        XCTAssertEqual(icon.label, "LiFlow")
        let shot = XCTAttachment(screenshot: icon.screenshot())
        shot.name = "ios-physical-liflow-launcher-icon"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
