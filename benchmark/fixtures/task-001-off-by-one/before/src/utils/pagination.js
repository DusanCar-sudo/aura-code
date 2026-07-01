/**
 * Returns the 1-indexed page of items for a given page number and page size.
 */
function paginate(items, pageNumber, pageSize) {
  const start = (pageNumber - 1) * pageSize;
  const end = start + pageSize;
  // BUG: off-by-one — includes one extra item from the next page
  return items.slice(start, end + 1);
}

module.exports = { paginate };
