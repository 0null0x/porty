mkdir porty-empty
mount --bind porty-empty system/priv-app/SetupWizard && echo "porty-x: SetupWizard hidden"
mount --bind porty-empty system/priv-app/Taskbar && echo "porty-x: Taskbar hidden"
mount --bind porty-empty system/priv-app/AnalyticsService && echo "porty-x: AnalyticsService hidden"
cat >> init.rc <<'PORTY_EOF'

on property:sys.boot_completed=1
    exec_background u:r:init:s0 -- /system/bin/sh -c "cmd settings put global device_provisioned 1; cmd settings put secure user_setup_complete 1; log -t porty provisioned"
PORTY_EOF
