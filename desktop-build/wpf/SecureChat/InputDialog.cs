using System.Windows;

namespace SecureChat;

public partial class InputDialog : Window
{
    public string Value => Input.Text?.Trim() ?? "";

    public InputDialog(string title, string label, string initial = "")
    {
        Title = title;
        Width = 400;
        Height = 190;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;

        var panel = new System.Windows.Controls.StackPanel { Margin = new Thickness(20) };
        panel.Children.Add(new System.Windows.Controls.TextBlock
        {
            Text = label,
            Foreground = System.Windows.Media.Brushes.Gray,
            Margin = new Thickness(0, 0, 0, 6)
        });
        Input = new System.Windows.Controls.TextBox
        {
            Text = initial,
            FontSize = 14,
            Height = 34,
            VerticalContentAlignment = System.Windows.VerticalAlignment.Center,
            Padding = new Thickness(8, 0, 8, 0)
        };
        panel.Children.Add(Input);
        var ok = new System.Windows.Controls.Button
        {
            Content = "确定",
            Width = 90,
            Height = 34,
            Margin = new Thickness(0, 16, 0, 0),
            HorizontalAlignment = System.Windows.HorizontalAlignment.Right
        };
        ok.Click += (_, _) => { DialogResult = true; };
        panel.Children.Add(ok);

        Content = panel;
        Input.KeyDown += (_, e) =>
        {
            if (e.Key == System.Windows.Input.Key.Enter) { DialogResult = true; }
        };
        Loaded += (_, _) => Input.Focus();
    }

    private System.Windows.Controls.TextBox Input;
}
