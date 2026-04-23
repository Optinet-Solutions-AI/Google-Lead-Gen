import { TableView } from '../../_components/table-view'

type Props = {
  params: Promise<{ board: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function BoardUpdatesPage({ params, searchParams }: Props) {
  const { board } = await params
  return <TableView boardSlug={board} kind="updates" searchParams={searchParams} />
}
