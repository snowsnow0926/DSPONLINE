package cn.dsponline.network;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.system.ErrnoException;
import android.system.Os;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.UUID;

@CapacitorPlugin(name = "DspTextExport")
public class TextExportPlugin extends Plugin {

    private static final long SHARE_GRANT_RETENTION_MILLIS = 15L * 60L * 1000L;
    private static final long ORPHAN_RETENTION_MILLIS = 24L * 60L * 60L * 1000L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        cleanupExpiredExports();
        super.load();
    }

    @PluginMethod
    public void exportAndShare(PluginCall call) {
        final byte[] bytes;
        try {
            bytes = TextExportProtocol.boundedUtf8(call.getString("contents"));
        } catch (IllegalArgumentException error) {
            call.reject("导出内容为空或超过安全上限", "TEXT_EXPORT_SIZE_INVALID");
            return;
        }
        exportBytesAndShare(call, bytes, "TEXT_EXPORT_SIZE_INVALID");
    }

    @PluginMethod
    public void exportBase64AndShare(PluginCall call) {
        final byte[] bytes;
        try {
            bytes = TextExportProtocol.boundedBase64(call.getString("contentsBase64"));
        } catch (IllegalArgumentException error) {
            call.reject("压缩导出内容为空、无效或超过安全上限", "BINARY_EXPORT_SIZE_INVALID");
            return;
        }
        exportBytesAndShare(call, bytes, "BINARY_EXPORT_SIZE_INVALID");
    }

    private void exportBytesAndShare(PluginCall call, byte[] bytes, String sizeErrorCode) {
        File requestDirectory = null;
        boolean chooserOpened = false;
        try {
            String fileName = TextExportProtocol.safeFileName(call.getString("fileName"));
            String mimeType = TextExportProtocol.safeMimeType(call.getString("mimeType"));
            requestDirectory = createRequestDirectory();
            File target = new File(requestDirectory, fileName);
            writeAtomically(requestDirectory, target, bytes);
            openChooser(target, mimeType, call.getString("title", "导出 DSP极简网络数据"));
            chooserOpened = true;
            scheduleCleanup(requestDirectory, target);
            call.resolve(new JSObject()
                .put("fileName", fileName)
                .put("byteLength", bytes.length)
                .put("chooserOpened", true));
        } catch (IllegalArgumentException error) {
            call.reject("导出内容为空或超过安全上限", sizeErrorCode);
        } catch (Exception error) {
            call.reject("无法打开系统保存或分享面板", "TEXT_EXPORT_FAILED");
        } finally {
            if (!chooserOpened) deleteTree(requestDirectory);
        }
    }

    private File createRequestDirectory() throws IOException {
        File root = privateExportRoot();
        if ((!root.exists() && !root.mkdirs()) || !root.isDirectory()) throw new IOException("export root unavailable");
        File directory = new File(root, "text-" + UUID.randomUUID().toString().replace("-", ""));
        if (!directory.mkdir()) throw new IOException("export directory unavailable");
        return directory;
    }

    private void writeAtomically(File directory, File target, byte[] bytes) throws Exception {
        File part = File.createTempFile(".text-", ".part", directory);
        boolean renamed = false;
        try (FileOutputStream output = new FileOutputStream(part, false)) {
            output.write(bytes);
            output.flush();
            output.getFD().sync();
            Os.rename(part.getAbsolutePath(), target.getAbsolutePath());
            fsyncDirectory(directory);
            renamed = true;
        } finally {
            if (!renamed && part.exists()) part.delete();
        }
    }

    private void openChooser(File file, String mimeType, String title) {
        Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".secureexportprovider",
            file
        );
        Intent share = new Intent(Intent.ACTION_SEND)
            .setType(mimeType)
            .putExtra(Intent.EXTRA_STREAM, uri);
        share.setClipData(ClipData.newRawUri(file.getName(), uri));
        share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(share, title == null || title.isBlank() ? "导出 DSP极简网络数据" : title);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getContext().startActivity(chooser);
    }

    private void fsyncDirectory(File directory) throws ErrnoException {
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(directory.getAbsolutePath(), android.system.OsConstants.O_RDONLY, 0);
            Os.fsync(descriptor);
        } finally {
            if (descriptor != null) Os.close(descriptor);
        }
    }

    private void scheduleCleanup(File directory, File file) {
        final Uri uri;
        try {
            uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".secureexportprovider",
                file
            );
        } catch (RuntimeException ignored) {
            return;
        }
        mainHandler.postDelayed(() -> {
            getContext().revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            deleteTree(directory);
        }, SHARE_GRANT_RETENTION_MILLIS);
    }

    private File privateExportRoot() {
        return new File(getContext().getFilesDir(), "private-exports");
    }

    private void cleanupExpiredExports() {
        File[] entries = privateExportRoot().listFiles();
        if (entries == null) return;
        long cutoff = System.currentTimeMillis() - ORPHAN_RETENTION_MILLIS;
        for (File entry : entries) {
            if (entry.getName().startsWith("text-") && entry.lastModified() < cutoff) deleteTree(entry);
        }
    }

    private void deleteTree(File target) {
        if (target == null || !target.exists()) return;
        try {
            String rootPath = privateExportRoot().getCanonicalPath() + File.separator;
            if (!target.getCanonicalPath().startsWith(rootPath)) return;
        } catch (IOException ignored) {
            return;
        }
        File[] children = target.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        target.delete();
    }
}
