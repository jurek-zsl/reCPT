package org.apache.commons.logging;
public interface Log {
  boolean isDebugEnabled(); boolean isInfoEnabled(); boolean isWarnEnabled(); boolean isErrorEnabled(); boolean isTraceEnabled(); boolean isFatalEnabled();
  void trace(Object m); void trace(Object m, Throwable t); void debug(Object m); void debug(Object m, Throwable t);
  void info(Object m); void info(Object m, Throwable t); void warn(Object m); void warn(Object m, Throwable t);
  void error(Object m); void error(Object m, Throwable t); void fatal(Object m); void fatal(Object m, Throwable t);
}
