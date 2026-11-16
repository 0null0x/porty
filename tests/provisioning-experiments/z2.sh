mkdir porty-empty
mount --bind porty-empty system/priv-app/SetupWizard && echo "porty-x: SetupWizard hidden"
mount --bind porty-empty system/priv-app/Taskbar && echo "porty-x: Taskbar hidden"
mount --bind porty-empty system/priv-app/AnalyticsService && echo "porty-x: AnalyticsService hidden"
