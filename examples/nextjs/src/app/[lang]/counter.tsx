'use client'

import { useI18n } from 'textlate/react'
import { useState } from 'react'

export const Counter = () => {
	const { translate } = useI18n()
	const [count, setCount] = useState(0)
	return (
		<section>
			<h2>{translate('Client Component')}</h2>
			<button onClick={() => setCount(count + 1)}>{translate('Click me')}</button>{' '}
			<span>{translate({ one: 'Clicked {count} time', other: 'Clicked {count} times' }, { count })}</span>
		</section>
	)
}
