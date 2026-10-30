// A small pipeline with deterministic cacheable work and one intentional failure.
package main

import (
	"context"
	"dagger/dagger-runs-sample/internal/dagger"
)

type DaggerRunsSample struct{}

func (m *DaggerRunsSample) Build() *dagger.Container {
	return dag.Container().From("alpine:3.21").
		WithExec([]string{"sh", "-c", "echo building; sleep 2; printf artifact >/tmp/artifact"})
}

func (m *DaggerRunsSample) Test(ctx context.Context) (string, error) {
	return m.Build().WithExec([]string{"sh", "-c", "test -s /tmp/artifact; printf '\\033[32mPASS: artifact exists\\033[0m\\n'"}).Stdout(ctx)
}

func (m *DaggerRunsSample) Fail(ctx context.Context) (string, error) {
	return m.Build().WithExec([]string{"sh", "-c", "echo running deliberate failure; sleep 3; printf '\\033[31mFAIL: expected 42, got 41\\033[0m\\n' >&2; exit 1"}).Stdout(ctx)
}
