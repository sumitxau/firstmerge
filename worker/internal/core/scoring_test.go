package core

import "testing"

func TestIsClaimedInComment(t *testing.T) {
	if !IsClaimedInComment("Hey team, I'll work on this today!") {
		t.Fatalf("expected claim phrase to be detected")
	}
	if !IsClaimedInComment("Can I take this issue?") {
		t.Fatalf("expected 'can i take this' to be detected")
	}
	if IsClaimedInComment("I reproduced this bug on Node 22 and Windows 11.") {
		t.Fatalf("did not expect bug report comment to be flagged")
	}
}

func TestComputeHealthScoreNullWhenInsufficientSample(t *testing.T) {
	total, resp, merge := ComputeHealthScore(RepoHealthInput{
		MedianReplyHours: -1,
		OutsideMergeRate: -1,
		DaysSincePush:    1,
		HasGoodFirst:     true,
		HasContributing:  true,
	})
	if resp != nil || merge != nil {
		t.Fatalf("expected nil pointers when sample size < 2")
	}
	if total < 60 || total > 99 {
		t.Fatalf("unexpected total health score: %d", total)
	}
}

func TestMedianAndRuneTruncation(t *testing.T) {
	if got := MedianFloat64([]float64{48, 2, 10, 6}); got != 8 {
		t.Fatalf("expected median 8, got %v", got)
	}
	if got := TruncateRunes("Hello\x00 world!", 7); got != "Hello w..." {
		t.Fatalf("unexpected truncation: %q", got)
	}
}
