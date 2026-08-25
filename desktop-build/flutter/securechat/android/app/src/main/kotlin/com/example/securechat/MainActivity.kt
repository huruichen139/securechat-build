package com.example.securechat

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    private val channelName = "securechat/installer"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "installApk" -> {
                    val path = call.argument<String>("path")
                    if (path == null) {
                        result.error("EINVAL", "path required", null)
                        return@setMethodCallHandler
                    }
                    try { result.success(installApk(File(path))) } catch (e: Exception) { result.error("EINSTALL", e.message, null) }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun installApk(apk: File): Boolean {
        if (!apk.exists()) throw IllegalArgumentException("APK 不存在")
        val uri: Uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
        } else {
            Uri.fromFile(apk)
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(intent)
            return true
        } catch (e: Exception) {
            // Android 8+ 无未知来源安装权限：引导用户开启后重试
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val perm = Intent("android.settings.MANAGE_UNKNOWN_APP_SOURCES", Uri.parse("package:$packageName"))
                perm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(perm)
            }
            return false
        }
    }
}
