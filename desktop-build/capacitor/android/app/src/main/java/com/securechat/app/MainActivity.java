package com.securechat.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int REQ_MEDIA = 7700;
    private PermissionRequest pendingWebPermission;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // WebView 的 getUserMedia 必须等待 Android 运行时权限完成后才能批准。
        bridge.getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }
        });
    }

    private void ensureMediaPermissions() {
        String[] perms = {
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        };
        java.util.List<String> need = new java.util.ArrayList<>();
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) need.add(p);
        }
        if (!need.isEmpty()) ActivityCompat.requestPermissions(this, need.toArray(new String[0]), REQ_MEDIA);
    }

    private void handleWebPermission(PermissionRequest request) {
        boolean needsCamera = false;
        boolean needsAudio = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needsCamera = true;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needsAudio = true;
        }
        boolean cameraOk = !needsCamera || ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean audioOk = !needsAudio || ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (cameraOk && audioOk) {
            request.grant(request.getResources());
            return;
        }
        if (pendingWebPermission != null) pendingWebPermission.deny();
        pendingWebPermission = request;
        ensureMediaPermissions();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MEDIA || pendingWebPermission == null) return;
        PermissionRequest request = pendingWebPermission;
        pendingWebPermission = null;
        boolean cameraOk = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean audioOk = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean needsCamera = false;
        boolean needsAudio = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needsCamera = true;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needsAudio = true;
        }
        if ((!needsCamera || cameraOk) && (!needsAudio || audioOk)) request.grant(request.getResources());
        else request.deny();
    }
}
