package cn.dsponline.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertArrayEquals;

import org.junit.Test;

public class TextExportProtocolTest {

    @Test
    public void sanitizesNamesAndBoundsUtf8Text() {
        assertEquals("player.json", TextExportProtocol.safeFileName("../player.json"));
        assertEquals("_CON", TextExportProtocol.safeFileName("CON"));
        assertEquals(3, TextExportProtocol.boundedUtf8("中").length);
        assertThrows(IllegalArgumentException.class, () -> TextExportProtocol.boundedUtf8(""));
        assertThrows(
            IllegalArgumentException.class,
            () -> TextExportProtocol.boundedUtf8("x".repeat(TextExportProtocol.MAXIMUM_TEXT_BYTES + 1))
        );
    }

    @Test
    public void decodesOnlyBoundedBase64ForWriteOnlyBinaryExport() {
        TextExportProtocol.Base64Decoder decoder = value -> java.util.Base64.getDecoder().decode(value);
        assertArrayEquals(new byte[] { 1, 2, 3 }, TextExportProtocol.boundedBase64("AQID", decoder));
        assertThrows(IllegalArgumentException.class, () -> TextExportProtocol.boundedBase64("", decoder));
        assertThrows(IllegalArgumentException.class, () -> TextExportProtocol.boundedBase64("not base64", decoder));
    }

    @Test
    public void allowsOnlyAClosedMimeTypeSet() {
        assertEquals("application/json", TextExportProtocol.safeMimeType("application/json"));
        assertEquals("text/plain; charset=utf-8", TextExportProtocol.safeMimeType("TEXT/PLAIN; charset=utf-8"));
        assertEquals("application/gzip", TextExportProtocol.safeMimeType("application/gzip"));
        assertEquals("application/json", TextExportProtocol.safeMimeType("text/html"));
    }
}
