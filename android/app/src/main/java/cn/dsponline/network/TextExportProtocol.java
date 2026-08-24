package cn.dsponline.network;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import android.util.Base64;

final class TextExportProtocol {

    interface Base64Decoder {
        byte[] decode(String value) throws IllegalArgumentException;
    }

    static final int MAXIMUM_TEXT_BYTES = 32 * 1024 * 1024;
    static final int MAXIMUM_BINARY_BYTES = 32 * 1024 * 1024;

    private TextExportProtocol() {}

    static String safeFileName(String value) {
        String leaf = value == null ? "" : value.replace('\\', '/');
        int slash = leaf.lastIndexOf('/');
        if (slash >= 0) leaf = leaf.substring(slash + 1);
        leaf = leaf
            .replaceAll("[\\x00-\\x1f\\x7f<>:\"/\\\\|?*]", "-")
            .replaceAll("\\s+", " ")
            .replaceAll("[. ]+$", "")
            .trim();
        if (leaf.isEmpty() || ".".equals(leaf) || "..".equals(leaf)) leaf = "dsp-export.json";
        if (leaf.matches("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$")) leaf = "_" + leaf;
        if (leaf.length() > 120) leaf = leaf.substring(0, 120).replaceAll("[. ]+$", "");
        return leaf.isEmpty() ? "dsp-export.json" : leaf;
    }

    static byte[] boundedUtf8(String value) {
        byte[] bytes = (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= 0 || bytes.length > MAXIMUM_TEXT_BYTES) {
            throw new IllegalArgumentException("Export text length is outside the supported range");
        }
        return bytes;
    }

    static byte[] boundedBase64(String value) {
        return boundedBase64(value, encoded -> Base64.decode(encoded, Base64.NO_WRAP));
    }

    static byte[] boundedBase64(String value, Base64Decoder decoder) {
        String encoded = value == null ? "" : value;
        int maximumEncodedCharacters = ((MAXIMUM_BINARY_BYTES + 2) / 3) * 4;
        if (encoded.isEmpty() || encoded.length() > maximumEncodedCharacters) {
            throw new IllegalArgumentException("Export binary length is outside the supported range");
        }
        final byte[] bytes;
        try {
            bytes = decoder.decode(encoded);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Export binary is not valid base64", error);
        }
        if (bytes.length <= 0 || bytes.length > MAXIMUM_BINARY_BYTES) {
            throw new IllegalArgumentException("Export binary length is outside the supported range");
        }
        return bytes;
    }

    static String safeMimeType(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (normalized.matches("^(application/(?:json|zip|gzip|octet-stream)|text/(?:plain|csv))(?:; ?charset=utf-8)?$")) return normalized;
        return "application/json";
    }
}
