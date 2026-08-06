import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:securechat/main.dart';
import 'package:securechat/services/app_config.dart';
import 'package:securechat/services/securechat_api.dart';

void main() {
  testWidgets('shows SecureChat login', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final sp = await SharedPreferences.getInstance();
    final config = AppConfig.load(sp);
    final api = SecureChatApi();
    await tester.pumpWidget(SecureChatApp(config: config, api: api));
    expect(find.text('登录 SecureChat'), findsOneWidget);
  });
}
