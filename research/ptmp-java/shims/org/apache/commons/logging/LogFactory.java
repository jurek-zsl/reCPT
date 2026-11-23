package org.apache.commons.logging;
/** Minimal stand-in for commons-logging: logs to stderr when PTB_DEBUG is set. */
public final class LogFactory {
  static final boolean ON = System.getenv("PTB_DEBUG") != null;
  public static Log getLog(Class<?> c) { return getLog(c.getSimpleName()); }
  public static Log getLog(String n) {
    return new Log() {
      void p(String l, Object m, Throwable t) { if (ON || l.equals("ERROR")) { System.err.println("[" + l + "] " + n + ": " + m); if (t != null && ON) t.printStackTrace(); } }
      public boolean isDebugEnabled() { return ON; } public boolean isInfoEnabled() { return ON; } public boolean isWarnEnabled() { return true; }
      public boolean isErrorEnabled() { return true; } public boolean isTraceEnabled() { return false; } public boolean isFatalEnabled() { return true; }
      public void trace(Object m) {} public void trace(Object m, Throwable t) {}
      public void debug(Object m) { p("DEBUG", m, null); } public void debug(Object m, Throwable t) { p("DEBUG", m, t); }
      public void info(Object m) { p("INFO", m, null); } public void info(Object m, Throwable t) { p("INFO", m, t); }
      public void warn(Object m) { p("WARN", m, null); } public void warn(Object m, Throwable t) { p("WARN", m, t); }
      public void error(Object m) { p("ERROR", m, null); } public void error(Object m, Throwable t) { p("ERROR", m, t); }
      public void fatal(Object m) { p("FATAL", m, null); } public void fatal(Object m, Throwable t) { p("FATAL", m, t); }
    };
  }
}
