using System.Windows;
using System.Windows.Controls;

namespace SecureChat;

public partial class FriendRequestsWindow : Window
{
    private readonly List<UserInfo> _requests = new();
    private readonly StackPanel _list = new();

    public FriendRequestsWindow()
    {
        Title = "好友请求";
        Width = 420;
        Height = 480;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;

        var root = new System.Windows.Controls.Grid { Margin = new Thickness(16) };
        root.RowDefinitions.Add(new RowDefinition());
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        scroll.Content = _list;
        root.Children.Add(scroll);

        var empty = new TextBlock
        {
            Text = "暂无待处理的好友请求",
            Foreground = System.Windows.Media.Brushes.Gray,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 20, 0, 0),
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 360
        };
        _list.Children.Add(empty);

        var closeBtn = new Button
        {
            Content = "关闭",
            Width = 90,
            Height = 32,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0)
        };
        closeBtn.Click += (_, _) => Close();
        System.Windows.Controls.Grid.SetRow(closeBtn, 1);
        root.Children.Add(closeBtn);

        Content = root;
        Loaded += async (_, _) => await LoadAsync();
    }

    private async Task LoadAsync()
    {
        var reqs = await ApiClient.GetFriendRequestsAsync();
        _requests.Clear();
        _requests.AddRange(reqs);
        _list.Children.Clear();

        if (_requests.Count == 0)
        {
            _list.Children.Add(new TextBlock
            {
                Text = "暂无待处理的好友请求",
                Foreground = System.Windows.Media.Brushes.Gray,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 20, 0, 0)
            });
            return;
        }

        foreach (var user in _requests)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };

            var avatar = new Border
            {
                Width = 40,
                Height = 40,
                CornerRadius = new CornerRadius(20),
                Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(16, 185, 129)),
                Child = new TextBlock
                {
                    Text = user.Initial,
                    Foreground = System.Windows.Media.Brushes.White,
                    FontSize = 16,
                    FontWeight = FontWeights.Bold,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                }
            };
            row.Children.Add(avatar);

            var info = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0) };
            info.Children.Add(new TextBlock { Text = user.DisplayName, FontWeight = FontWeights.SemiBold });
            info.Children.Add(new TextBlock { Text = "ID: " + user.Uid, FontSize = 11, Foreground = System.Windows.Media.Brushes.Gray });
            row.Children.Add(info);

            var acceptBtn = new Button
            {
                Content = "接受",
                Width = 64,
                Height = 30,
                Margin = new Thickness(8, 0, 0, 0),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
                Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(7, 193, 96)),
                Foreground = System.Windows.Media.Brushes.White,
                BorderThickness = new Thickness(0)
            };
            var uid = user.Id;
            acceptBtn.Click += async (_, _) =>
            {
                var (ok, err) = await ApiClient.AcceptFriendAsync(uid);
                if (!ok) { MessageBox.Show(this, err ?? "操作失败", "SecureChat", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
                await LoadAsync();
            };
            row.Children.Add(acceptBtn);

            var rejectBtn = new Button
            {
                Content = "拒绝",
                Width = 64,
                Height = 30,
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Background = System.Windows.Media.Brushes.Transparent,
                BorderBrush = System.Windows.Media.Brushes.LightGray
            };
            var rid = user.Id;
            rejectBtn.Click += async (_, _) =>
            {
                await ApiClient.RejectFriendAsync(rid);
                await LoadAsync();
            };
            row.Children.Add(rejectBtn);

            _list.Children.Add(row);
        }
    }
}
