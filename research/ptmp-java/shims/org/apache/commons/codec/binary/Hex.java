package org.apache.commons.codec.binary;
import org.apache.commons.codec.DecoderException;
public class Hex {
  private static final char[] D = "0123456789abcdef".toCharArray();
  public static char[] encodeHex(byte[] b) { char[] o = new char[b.length * 2]; for (int i = 0; i < b.length; i++) { o[2*i] = D[(b[i] >> 4) & 15]; o[2*i+1] = D[b[i] & 15]; } return o; }
  public static byte[] decodeHex(char[] c) throws DecoderException {
    if ((c.length & 1) != 0) throw new DecoderException("Odd number of characters.");
    byte[] o = new byte[c.length / 2];
    for (int i = 0; i < o.length; i++) { int h = Character.digit(c[2*i], 16), l = Character.digit(c[2*i+1], 16); if (h < 0 || l < 0) throw new DecoderException("Illegal hexadecimal character"); o[i] = (byte) ((h << 4) | l); }
    return o;
  }
  public byte[] decode(byte[] b) throws DecoderException { return decodeHex(new String(b, java.nio.charset.StandardCharsets.US_ASCII).toCharArray()); }
  public byte[] encode(byte[] b) { return new String(encodeHex(b)).getBytes(java.nio.charset.StandardCharsets.US_ASCII); }
}
