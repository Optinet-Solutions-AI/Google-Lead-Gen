import { PageSkeleton } from '../../_components/page-skeleton'

export default function Loading() {
  return <PageSkeleton rows={8} stats={4} controls={true} />
}
