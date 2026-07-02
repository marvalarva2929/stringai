import UIKit

final class HomeIndicatorWrapper: UIViewController {
    static var hidden = false

    override var prefersHomeIndicatorAutoHidden: Bool { HomeIndicatorWrapper.hidden }

    // Don't delegate to children — we own the preference
    override var childForHomeIndicatorAutoHidden: UIViewController? { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleChange(_:)),
            name: Notification.Name("PoseCameraSetHomeIndicatorHidden"),
            object: nil
        )
    }

    @objc private func handleChange(_ note: Notification) {
        HomeIndicatorWrapper.hidden = note.userInfo?["hidden"] as? Bool ?? false
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    func embed(_ child: UIViewController) {
        addChild(child)
        child.view.frame = view.bounds
        child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(child.view)
        child.didMove(toParent: self)
    }
}
