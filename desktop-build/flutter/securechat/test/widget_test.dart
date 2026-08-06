import 'package:flutter_test/flutter_test.dart';
import 'package:securechat/main.dart';

void main() {
  testWidgets('shows SecureChat login', (tester) async {
    await tester.pumpWidget(const SecureChatApp());
    expect(find.text('登录 SecureChat'), findsOneWidget);
  });
}
