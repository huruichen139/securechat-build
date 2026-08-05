package com.securechat.app;

import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.webkit.WebView;

import androidx.appcompat.app.AppCompatActivity;

import com.getcapacitor.BridgeActivity;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final String SERVER = "https://mc.32768.top:8888";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private LinearLayout loginPanel;
    private EditText accountInput;
    private EditText passwordInput;
    private TextView errorText;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        showNativeLogin();
    }

    private void showNativeLogin() {
        WebView web = getBridge().getWebView();
        web.setVisibility(View.INVISIBLE);
        loginPanel = new LinearLayout(this);
        loginPanel.setOrientation(LinearLayout.VERTICAL);
        loginPanel.setPadding(48, 80, 48, 32);
        loginPanel.setBackgroundColor(Color.WHITE);

        TextView title = label("SecureChat", 30, Color.rgb(7, 193, 96));
        TextView subtitle = label("安全通信空间", 16, Color.DKGRAY);
        accountInput = input("用户名或邮箱");
        passwordInput = input("密码");
        passwordInput.setInputType(0x81);
        Button login = button("密码登录");
        Button scan = button("扫码登录");
        Button resume = button("已有登录态，直接进入");
        errorText = label("", 14, Color.rgb(210, 50, 50));
        login.setOnClickListener(v -> passwordLogin());
        scan.setOnClickListener(v -> startQrScan());
        resume.setOnClickListener(v -> resumeLogin());
        loginPanel.addView(title); loginPanel.addView(subtitle);
        loginPanel.addView(accountInput); loginPanel.addView(passwordInput);
        loginPanel.addView(login); loginPanel.addView(scan); loginPanel.addView(resume); loginPanel.addView(errorText);
        addContentView(loginPanel, new ViewGroup.LayoutParams(-1, -1));
    }

    private TextView label(String text, int size, int color) {
        TextView v = new TextView(this); v.setText(text); v.setTextSize(size); v.setTextColor(color); v.setPadding(0, 12, 0, 12); return v;
    }

    private EditText input(String hint) {
        EditText v = new EditText(this); v.setHint(hint); v.setSingleLine(true); v.setPadding(0, 18, 0, 18); return v;
    }

    private Button button(String text) { Button b = new Button(this); b.setText(text); return b; }

    private void resumeLogin() {
        getBridge().getWebView().evaluateJavascript("(function(){try{var t=localStorage.getItem('sc_token');var m=localStorage.getItem('sc_me');return t&&m?'1':'0'}catch(e){return '0'}})()", value -> {
            if ("\"1\"".equals(value) || "1".equals(value)) { loginPanel.setVisibility(View.GONE); getBridge().getWebView().setVisibility(View.VISIBLE); }
            else errorText.setText("未检测到登录态，请使用密码或扫码登录");
        });
    }

    private void passwordLogin() {
        final String account = accountInput.getText().toString().trim();
        final String password = passwordInput.getText().toString();
        if (account.isEmpty() || password.isEmpty()) { errorText.setText("请输入用户名和密码"); return; }
        errorText.setText("登录中...");
        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("account", account).put("password", password);
                JSONObject result = post("/api/login", body.toString());
                runOnUiThread(() -> enterChat(result));
            } catch (Exception e) { runOnUiThread(() -> errorText.setText(e.getMessage())); }
        });
    }

    private void startQrScan() {
        IntentIntegrator scanner = new IntentIntegrator(this);
        scanner.setPrompt("扫描 SecureChat 登录二维码"); scanner.setBeepEnabled(false); scanner.setOrientationLocked(false); scanner.initiateScan();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null && result.getContents() != null) {
            String raw = result.getContents();
            int p = raw.indexOf("token=");
            if (p >= 0) consumeQr(raw.substring(p + 6).split("&")[0]); else errorText.setText("二维码不是 SecureChat 登录码");
        } else super.onActivityResult(requestCode, resultCode, data);
    }

    private void consumeQr(String token) {
        errorText.setText("登录中...");
        executor.execute(() -> {
            try { JSONObject result = post("/api/login/qr/consume", new JSONObject().put("token", token).toString());
                if (!"ok".equals(result.optString("status"))) throw new Exception("二维码已过期，请重新生成");
                runOnUiThread(() -> enterChat(result));
            } catch (Exception e) { runOnUiThread(() -> errorText.setText(e.getMessage())); }
        });
    }

    private JSONObject post(String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(SERVER + path).openConnection();
        c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
        BufferedReader r = new BufferedReader(new InputStreamReader(c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream(), StandardCharsets.UTF_8));
        StringBuilder s = new StringBuilder(); String line; while ((line = r.readLine()) != null) s.append(line); JSONObject result = new JSONObject(s.toString());
        if (c.getResponseCode() >= 400) throw new Exception(result.optString("error", "请求失败")); return result;
    }

    private void enterChat(JSONObject result) {
        try {
            String token = result.getString("token"); JSONObject user = result.getJSONObject("user");
            String script = "localStorage.setItem('sc_token'," + JSONObject.quote(token) + ");localStorage.setItem('sc_me'," + JSONObject.quote(user.toString()) + ");location.reload();";
            getBridge().getWebView().evaluateJavascript(script, null);
            loginPanel.setVisibility(View.GONE); getBridge().getWebView().setVisibility(View.VISIBLE);
        } catch (Exception e) { errorText.setText(e.getMessage()); }
    }
}
