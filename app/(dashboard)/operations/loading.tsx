import { PageSkeleton } from '../_components/page-skeleton'

export default function Loading() {
  return <PageSkeleton rows={6} stats={4} controls={false} />
}
