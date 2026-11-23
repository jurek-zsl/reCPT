package org.apache.commons.lang.builder;
public class ToStringBuilder {
  private final StringBuilder sb; private boolean first = true;
  public ToStringBuilder(Object o) { sb = new StringBuilder(o == null ? "null" : o.getClass().getSimpleName()).append('['); }
  public ToStringBuilder append(String k, Object v) { if (!first) sb.append(','); first = false; sb.append(k).append('=').append(v); return this; }
  public ToStringBuilder append(String k, int v) { return append(k, (Object) v); }
  public ToStringBuilder append(String k, boolean v) { return append(k, (Object) v); }
  public ToStringBuilder append(String k, long v) { return append(k, (Object) v); }
  @Override public String toString() { return sb + "]"; }
}
