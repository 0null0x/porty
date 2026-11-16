# experiment: no setup wizard (as if removed from the image), provision at boot_completed
mkdir porty-empty
mount --bind porty-empty system/priv-app/SetupWizard && echo "porty-x: SetupWizard hidden"
ls -la system/etc/preferred-apps system/vendor/overlay 2>&1
cat >> init.rc <<'PORTY_EOF'

on property:sys.boot_completed=1
    exec_background u:r:init:s0 -- /system/bin/sh -c "cmd settings put global device_provisioned 1; cmd settings put secure user_setup_complete 1; log -t porty provisioned"
PORTY_EOF
echo "porty-x: init.rc has $(grep -c porty init.rc) porty line(s)"
