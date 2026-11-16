# experiment: no setup wizard (as if removed from the image), nothing else
mkdir porty-empty
mount --bind porty-empty system/priv-app/SetupWizard && echo "porty-x: SetupWizard hidden"
