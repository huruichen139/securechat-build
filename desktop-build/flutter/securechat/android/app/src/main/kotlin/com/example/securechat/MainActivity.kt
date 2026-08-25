package com.example.securechat

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
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
                "canInstall" -> {
                    // Android 8+ 需要未知来源安装权限
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        result.success(Settings.canRequestPackageInstalls())
                    } else result.success(true)
                }
                "requestInstallPermission" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
                        startActivity(i)
                    }
                    result.success(true)
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
        // Android 8+ 先检查未知来源安装权限，无权限则引导开启
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !Settings.canRequestPackageInstalls()) {
            val perm = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
            startActivity(perm)
            return false
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
        return true
    }
}
