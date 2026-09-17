import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:securechat/widgets/turnstile_widget.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:securechat/main.dart';
import 'package:securechat/services/app_config.dart';
import 'package:securechat/services/securechat_api.dart';

class _CaptchaServer {
  final requests = <http.Request>[];
  int captchaLoads = 0;

  http.Client client() => MockClient((request) async {
    requests.add(request);
    final Map<String, dynamic> body;
    switch ('${request.method} ${request.url.path}') {
      case 'GET /api/captcha/config':
        body = {
          'turnstile': {'site': 'widget-test-site'},
        };
      case 'GET /api/captcha':
        captchaLoads++;
        body = {
          'id': 'captcha-$captchaLoads',
          'svg':
              '<svg xmlns="http://www.w3.org/2000/svg" '
              'width="120" height="40" viewBox="0 0 120 40">'
              '<path fill="${captchaLoads.isOdd ? '#123456' : '#654321'}" '
              'd="M10 5h10v30H10zM40 5h20v5H40z"/></svg>',
        };
      case 'POST /api/email/code':
        body = {'ok': true};
      default:
        fail('Unexpected HTTP request: ${request.method} ${request.url.path}');
    }
    return http.Response(
      jsonEncode(body),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  });
}

Finder _field(String label) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.labelText == label,
);

Finder _verticalScroll(Finder root) => find.descendant(
  of: root,
  matching: find.byWidgetPredicate(
    (widget) =>
        widget is Scrollable && widget.axisDirection == AxisDirection.down,
  ),
);

Future<void> _reveal(WidgetTester tester, Finder target) async {
  expect(target, findsOneWidget);
  await tester.pumpAndSettle();
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  expect(target.hitTestable(), findsOneWidget);
  final rect = tester.getRect(target);
  final view = tester.view;
  expect(rect.left, greaterThanOrEqualTo(0));
  expect(
    rect.right,
    lessThanOrEqualTo(view.physicalSize.width / view.devicePixelRatio),
  );
  expect(rect.top, greaterThanOrEqualTo(0));
  expect(
    rect.bottom,
    lessThanOrEqualTo(
      (view.physicalSize.height - view.viewInsets.bottom) /
          view.devicePixelRatio,
    ),
  );
}

Future<void> _mountLogin(WidgetTester tester) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(320, 480);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetViewInsets);
  SharedPreferences.setMockInitialValues({'cfg_effect': '0'});
  final config = AppConfig.load(await SharedPreferences.getInstance());
  addTearDown(config.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: config.theme.theme(),
      home: LoginPage(config: config),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _exerciseGraphicalCaptcha(
  WidgetTester tester,
  _CaptchaServer server, {
  required bool forgot,
  required double keyboardInset,
}) async {
  await _mountLogin(tester);
  if (forgot) {
    await _reveal(tester, find.text('忘记密码？'));
    await tester.tap(find.text('忘记密码？'));
  } else {
    await tester.tap(find.text('邮箱验证码'));
  }
  await tester.pumpAndSettle();
  if (find.text('改用图形验证码').evaluate().isNotEmpty) {
    await _reveal(tester, find.text('改用图形验证码'));
    await tester.tap(find.text('改用图形验证码'));
    await tester.pumpAndSettle();
  }
  final root = find.byType(forgot ? Dialog : LoginPage);
  final scrollable = _verticalScroll(root);
  expect(scrollable, findsOneWidget);
  final email = _field(forgot ? '注册邮箱' : '邮箱地址');
  await _reveal(tester, email);
  await tester.enterText(email, 'captcha-test@example.invalid');
  tester.view.viewInsets = FakeViewPadding(bottom: keyboardInset);
  await tester.pumpAndSettle();
  expect(MediaQuery.of(tester.element(root)).viewInsets.bottom, keyboardInset);

  final digits = _field('图中数字');
  final svg = find.descendant(of: root, matching: find.byType(SvgPicture));
  final refresh = find.descendant(of: root, matching: find.byTooltip('刷新'));
  expect(svg, findsOneWidget);
  expect(server.captchaLoads, greaterThan(0));
  expect(tester.widget<TextField>(digits).maxLength, 6);
  expect(tester.widget<TextField>(digits).enabled, isNot(false));
  expect(
    tester.getRect(digits).top,
    greaterThanOrEqualTo(tester.getRect(svg).bottom),
  );
  final position = tester.state<ScrollableState>(scrollable).position;
  expect(position.maxScrollExtent, greaterThan(0));
  position.jumpTo(0);
  await tester.pumpAndSettle();
  final beforeDrag = position.pixels;
  await tester.drag(scrollable, const Offset(0, -100));
  await tester.pumpAndSettle();
  expect(position.pixels, greaterThan(beforeDrag));

  await _reveal(tester, digits);
  await tester.enterText(digits, '1234567');
  expect(tester.widget<TextField>(digits).controller!.text, '123456');
  await _reveal(tester, refresh);
  final firstLoads = server.captchaLoads;
  final firstImage = tester.widget<SvgPicture>(svg).bytesLoader;
  await tester.tap(refresh);
  await tester.pumpAndSettle();
  expect(server.captchaLoads, firstLoads + 1);
  expect(tester.widget<TextField>(digits).controller!.text, isEmpty);
  expect(tester.widget<SvgPicture>(svg).bytesLoader, isNot(equals(firstImage)));

  await _reveal(tester, digits);
  await tester.enterText(digits, '654321');
  await _reveal(tester, svg);
  await tester.tap(svg);
  await tester.pumpAndSettle();
  expect(server.captchaLoads, firstLoads + 2);
  expect(tester.widget<TextField>(digits).controller!.text, isEmpty);

  await _reveal(tester, digits);
  await tester.enterText(digits, '123456');
  final submittedId = 'captcha-${server.captchaLoads}';
  final send = find.descendant(
    of: root,
    matching: find.widgetWithText(OutlinedButton, '获取验证码'),
  );
  await _reveal(tester, send);
  await tester.tap(send);
  await tester.pumpAndSettle();
  final posts = server.requests.where((request) => request.method == 'POST');
  expect(posts, hasLength(1));
  expect(jsonDecode(posts.single.body), {
    'email': 'captcha-test@example.invalid',
    'purpose': forgot ? 'reset' : 'login',
    'captchaId': submittedId,
    'captchaText': '123456',
  });
  expect(server.captchaLoads, firstLoads + 3);
  expect(svg, findsOneWidget);
  expect(tester.widget<TextField>(digits).controller!.text, isEmpty);
  expect(find.text('60 s'), findsOneWidget);

  final submit = find.descendant(
    of: root,
    matching: find.widgetWithText(FilledButton, forgot ? '重置密码' : '登录'),
  );
  await _reveal(tester, submit);
  await tester.tap(submit);
  await tester.pumpAndSettle();
  final validation = find.text(forgot ? '请完整填写邮箱、验证码和新密码' : '请先输入图形验证码');
  await _reveal(tester, validation);
  expect(
    server.requests.where((request) => request.method == 'POST'),
    hasLength(1),
  );

  await _reveal(tester, find.text('改用Turnstile'));
  await tester.tap(find.text('改用Turnstile'));
  await tester.pumpAndSettle();
  expect(find.byType(TurnstileWidget), findsOneWidget);
  expect(svg, findsNothing);
  await _reveal(tester, find.text('改用图形验证码'));
  await tester.tap(find.text('改用图形验证码'));
  await tester.pumpAndSettle();
  expect(svg, findsOneWidget);
  expect(server.captchaLoads, firstLoads + 4);
  await _reveal(tester, refresh);
  expect(tester.takeException(), isNull);
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows SecureChat login', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final sp = await SharedPreferences.getInstance();
    final config = AppConfig.load(sp);
    final api = SecureChatApi();
    await tester.pumpWidget(SecureChatApp(config: config, api: api));
    expect(find.text('登录 SecureChat'), findsOneWidget);
  });

  for (final forgot in [false, true]) {
    for (final keyboardInset in [0.0, 280.0]) {
      testWidgets(
        '${forgot ? 'forgot password' : 'email login'} graphical captcha '
        'at 320px with ${keyboardInset.toInt()}px keyboard inset',
        (tester) async {
          final server = _CaptchaServer();
          await http.runWithClient(
            () => _exerciseGraphicalCaptcha(
              tester,
              server,
              forgot: forgot,
              keyboardInset: keyboardInset,
            ),
            server.client,
          );
        },
        variant: TargetPlatformVariant.only(TargetPlatform.linux),
      );
    }
  }

  for (final width in [240.0, 320.0]) {
    testWidgets(
      'Turnstile unsupported-platform retry at ${width.toInt()}px',
      (tester) async {
        var errors = 0;
        final tokens = <String>[];
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: width,
                  child: TurnstileWidget(
                    siteKey: 'widget-test-site',
                    baseUrl: 'https://captcha-test.invalid/',
                    onToken: tokens.add,
                    onError: () => errors++,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(TurnstileWidget), findsOneWidget);
        expect(
          tester.getSize(find.byType(TurnstileWidget)),
          Size(width, width < 300 ? 150 : 70),
        );
        expect(find.text('验证加载失败或已过期'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(errors, 1);
        final retry = find.widgetWithText(TextButton, '重试');
        for (var attempt = 0; attempt < 2; attempt++) {
          await _reveal(tester, retry);
          await tester.tap(retry);
          await tester.pumpAndSettle();
          expect(errors, attempt + 2);
          expect(find.text('验证加载失败或已过期'), findsOneWidget);
          expect(find.byType(CircularProgressIndicator), findsNothing);
          expect(tokens, isEmpty);
        }
        await tester.pump(const Duration(seconds: 31));
        expect(errors, 3);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(seconds: 31));
        expect(errors, 3);
        expect(tester.takeException(), isNull);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.linux),
    );
  }
}
