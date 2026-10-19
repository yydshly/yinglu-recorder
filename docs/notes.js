// This page is an offline documentation snapshot, not a live test dashboard.
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault(); selectTab(tabs[index]); tabs[index].focus();
  });
}

const filters = [...document.querySelectorAll('[data-filter]')];
const issues = [...document.querySelectorAll('.issue')];
const search = document.getElementById('issue-search');
let filter = 'all';
function filterIssues() {
  const query = search.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const issue of issues) {
    const match = (filter === 'all' || issue.dataset.state === filter) && (!query || issue.textContent.toLocaleLowerCase().includes(query));
    issue.hidden = !match; if (match) visible++;
  }
  document.getElementById('issue-count').textContent = `显示 ${visible} / ${issues.length} 条记录`;
  document.getElementById('issue-empty').hidden = visible !== 0;
}
for (const button of filters) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const item of filters) item.setAttribute('aria-pressed', String(item === button));
  filterIssues();
});
search.addEventListener('input', filterIssues);

const sections = [...document.querySelectorAll('section.observed')];
const links = [...document.querySelectorAll('.toc a')];
let queued = false;
function markSection() {
  queued = false;
  const limit = innerWidth <= 760 ? 145 : 140;
  let current = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= limit) current = section;
  }
  // At the document end, a short last section should still own the navigation.
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 6) current = sections.at(-1);
  for (const link of links) {
    if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
addEventListener('scroll', () => {
  if (!queued) { queued = true; requestAnimationFrame(markSection); }
}, { passive: true });
addEventListener('resize', markSection);
markSection();

document.getElementById('print').addEventListener('click', () => print());
// Make collapsed details available to print, then restore the reader's view.
let closedForPrint = [];
addEventListener('beforeprint', () => {
  closedForPrint = [...document.querySelectorAll('details:not([open])')];
  for (const details of closedForPrint) details.open = true;
});
addEventListener('afterprint', () => {
  for (const details of closedForPrint) details.open = false;
  closedForPrint = [];
});
