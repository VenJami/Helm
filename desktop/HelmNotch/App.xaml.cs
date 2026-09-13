using System.Windows;

namespace HelmNotch;

public partial class App : Application
{
    // Where the notch points. Defaults to Helm on its usual port; override with
    // the first command-line argument (the launcher passes one when PORT is set,
    // and it is how the self-test aims at a local file instead of the server).
    public const string DefaultUrl = "http://127.0.0.1:7777/hud?notch=1";

    public string TargetUrl { get; private set; } = DefaultUrl;

    protected override void OnStartup(StartupEventArgs e)
    {
        if (e.Args.Length > 0 && !string.IsNullOrWhiteSpace(e.Args[0])) TargetUrl = e.Args[0];
        base.OnStartup(e);
        new MainWindow(TargetUrl).Show();
    }
}
