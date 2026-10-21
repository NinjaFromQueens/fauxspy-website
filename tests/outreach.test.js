// Outreach and Reddit drafting: filters and the drafts people read.
// Pure functions only; no network.  Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const outreach = require('../scripts/backlink-finder');
const reddit = require('../scripts/reddit-reply');

test('government and military sites are never outreach targets', () => {
  for (const d of ['consumer.ftc.gov', 'cisa.gov', 'army.mil', 'secretservice.gov', 'gov.uk', 'scamwatch.gov.au', 'canada.gc.ca']) {
    assert.equal(outreach.isExcludedDomain(d), true, d);
  }
  for (const d of ['datingsafetyblog.com', 'govtech.com', 'aarp.org']) {
    assert.equal(outreach.isExcludedDomain(d), false, d);
  }
});

test('only real editorial addresses are kept', () => {
  const rejected = [
    'central@cisa.dhs.gov',          // government
    'youremail@email.com',           // template
    'duroneppsjr7@gmail.com',        // our own
    'customercare@imageskincare.com',
    'info@site.com', 'noreply@site.com', 'jane@example.com',
  ];
  for (const e of rejected) assert.equal(outreach.isUsableEmail(e), false, e);
  for (const e of ['editor@datingsafetyblog.com', 'sarah.k@scamaware.org']) {
    assert.equal(outreach.isUsableEmail(e), true, e);
  }
  assert.deepEqual(
    outreach.findEmails('<a href="mailto:info@x.com">x</a> write to editor@x.com or youremail@email.com'),
    ['editor@x.com'],
  );
});

test('each run uses 10 searches and every query comes up within a few weeks', () => {
  const seen = new Set();
  for (let week = 0; week < 5; week++) {
    const q = outreach.queriesForThisRun(Date.UTC(2026, 9, 19) + week * 7 * 864e5);
    assert.equal(q.length, 10);
    assert.equal(new Set(q).size, 10);
    q.forEach(x => seen.add(x));
  }
  assert.equal(seen.size, outreach.SEARCH_QUERIES.length);
});

test('every draft carries an opt-out and a mailing address line', () => {
  assert.match(outreach.emailFooter(''), /reply "no thanks"/);
  assert.match(outreach.emailFooter(''), /\[Add your mailing address here before sending\]/);
  assert.match(outreach.emailFooter('PO Box 1, Queens NY'), /PO Box 1, Queens NY$/);
});

test('the drafts issue says nothing was sent and gives a ready-to-send link', () => {
  const body = outreach.renderIssue({
    displayDate: 'October 26, 2026',
    address: '',
    searchesFailed: 0,
    drafts: [{
      domain: 'datingsafetyblog.com', url: 'https://datingsafetyblog.com/spot-fakes', title: 'Spot fake profiles',
      reason: 'A guide to spotting fake dating profiles.', subject: 'Your fake-profile guide',
      body: 'Hi Sam,\n...\nDuron, Faux Spy (fauxspy.com)' + outreach.emailFooter(''),
      email: 'sam@datingsafetyblog.com', contactPage: null,
    }],
    skipped: [{ domain: 'imageskincare.com', url: 'https://imageskincare.com', reason: 'Sells skincare, unrelated.' }],
  });
  assert.match(body, /\*\*Nothing was sent\.\*\*/);
  assert.match(body, /mailto:sam@datingsafetyblog\.com\?subject=/);
  assert.match(body, /Add your mailing address/);
  assert.match(body, /imageskincare\.com\): Sells skincare/);
});

test('Reddit: only help-seeking posts on the topic qualify', () => {
  assert.equal(reddit.matchesTrigger('Is this profile a catfish?'), true);
  assert.equal(reddit.matchesTrigger('Best pizza in town'), false);
  assert.equal(reddit.shouldSkip('someone mentioned faux spy already'), true);
  assert.equal(reddit.isQuestion({ title: 'How do I tell if these photos are AI?', selftext: '' }), true);
});

test('Reddit drafts are rendered for a person to post, with the disclosure flagged', () => {
  const md = reddit.renderDrafts([{
    subreddit: 'Scams',
    post: { title: 'Is this profile fake?', permalink: '/r/Scams/comments/abc/x/', score: 12, num_comments: 4 },
    decision: { mentionsFauxSpy: true, replyText: '(Disclosure: I make this) Faux Spy can check the photo.' },
  }]);
  assert.match(md, /https:\/\/www\.reddit\.com\/r\/Scams\/comments\/abc\/x\//);
  assert.match(md, /mentions Faux Spy \(disclosed\)/);
});
