package core

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

var (
	RepoFullNameRegex = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	claimPhraseRegex  = regexp.MustCompile(`(?i)\b(i'?ll work on this|i will work on this|can i take this|can i work on this|i would like to work on this|working on this|assign this to me|please assign me|taking this)\b`)
)

func IsClaimedInComment(commentBody string) bool {
	return claimPhraseRegex.MatchString(commentBody)
}

func TruncateRunes(s string, maxRunes int) string {
	clean := SanitizeUTF8(strings.TrimSpace(s))
	runes := []rune(clean)
	if len(runes) <= maxRunes {
		return clean
	}
	return string(runes[:maxRunes]) + "..."
}

func EstimateIssueDifficulty(labels []string, body string, commentCount int) string {
	joined := strings.ToLower(strings.Join(labels, " "))
	if strings.Contains(joined, "good first issue") ||
		strings.Contains(joined, "easy") ||
		strings.Contains(joined, "beginner") ||
		strings.Contains(joined, "starter") {
		return "easy"
	}
	if len([]rune(strings.TrimSpace(body))) < 50 {
		return "unknown"
	}
	if commentCount > 10 || strings.Contains(joined, "hard") || strings.Contains(joined, "complex") {
		return "hard"
	}
	return "medium"
}

func MedianFloat64(values []float64) float64 {
	if len(values) == 0 {
		return -1
	}
	cp := append([]float64(nil), values...)
	sort.Float64s(cp)
	mid := len(cp) / 2
	if len(cp)%2 == 1 {
		return cp[mid]
	}
	return (cp[mid-1] + cp[mid]) / 2.0
}

type RepoHealthInput struct {
	MedianReplyHours float64 // -1 if sample size < 2
	OutsideMergeRate float64 // -1 if sample size < 2
	DaysSincePush    float64
	HasGoodFirst     bool
	HasContributing  bool
}

func ComputeHealthScore(in RepoHealthInput) (total int, respScore *int, mergeScore *int) {
	rVal := 65
	if in.MedianReplyHours >= 0 {
		var calc int
		switch {
		case in.MedianReplyHours <= 12:
			calc = 96
		case in.MedianReplyHours <= 48:
			calc = 82
		case in.MedianReplyHours <= 168:
			calc = 65
		default:
			calc = 40
		}
		rVal = calc
		respScore = &calc
	}

	mVal := 65
	if in.OutsideMergeRate >= 0 {
		calc := int(math.Round(in.OutsideMergeRate * 100))
		if calc < 10 {
			calc = 10
		}
		if calc > 98 {
			calc = 98
		}
		mVal = calc
		mergeScore = &calc
	}

	actScore := 40.0
	switch {
	case in.DaysSincePush <= 2:
		actScore = 98
	case in.DaysSincePush <= 7:
		actScore = 88
	case in.DaysSincePush <= 30:
		actScore = 70
	}

	welcomeScore := 30.0
	if in.HasGoodFirst {
		welcomeScore += 40.0
	}
	if in.HasContributing {
		welcomeScore += 30.0
	}

	raw := 0.35*float64(rVal) + 0.30*float64(mVal) + 0.20*actScore + 0.15*welcomeScore
	total = int(math.Round(raw))
	if total > 99 {
		total = 99
	}
	return total, respScore, mergeScore
}
