package org.apache.commons.collections.iterators;
import java.util.*;
public class ReverseListIterator implements Iterator<Object> {
  private final ListIterator<?> it;
  public ReverseListIterator(List<?> l) { it = l.listIterator(l.size()); }
  public boolean hasNext() { return it.hasPrevious(); } public Object next() { return it.previous(); } public void remove() { it.remove(); }
}
